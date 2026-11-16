"""Aura chat: safety preamble → provider tool loop (validated, permission-checked, audited) → stored conversation."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import timedelta
from typing import Any, AsyncIterator

from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..config import get_settings
from ..models import AuraConversation, AuraMessage, User
from ..services import snapshot
from ..services.settings_store import get_config
from ..timeutil import now as utcnow
from . import prompts, providers, safety, tools

log = logging.getLogger("orion.aura")


def ev(type_: str, **data: Any) -> dict:
    return {"type": type_, **data}


async def _conversation(db: AsyncSession, user: User, conv_id: str | None, first_text: str) -> AuraConversation:
    if conv_id:
        c = await db.get(AuraConversation, conv_id)
        if c and c.user_id == user.id:
            return c
    c = AuraConversation(user_id=user.id, title=first_text[:80])
    db.add(c)
    await db.flush()
    return c


async def _history(db: AsyncSession, conv: AuraConversation, n: int) -> list[dict]:
    rows = list((await db.execute(select(AuraMessage).where(AuraMessage.conversation_id == conv.id).order_by(AuraMessage.id.desc()).limit(n))).scalars())
    rows.reverse()
    msgs = [{"role": r.role, "content": r.text} for r in rows if r.text]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    # merge consecutive same-role messages (the API needs alternating roles)
    out: list[dict] = []
    for m in msgs:
        if out and out[-1]["role"] == m["role"]:
            out[-1]["content"] += "\n" + m["content"]
        else:
            out.append(m)
    return out


async def chat(db: AsyncSession, user: User, text: str, conv_id: str | None, language: str, voice: bool, page: str | None, ip: str) -> AsyncIterator[dict]:
    """Yields events: safety, step, text, action, done, error/unavailable. Caller commits."""
    st = get_settings()
    conv = await _conversation(db, user, conv_id, text)
    snap = await snapshot.overview(db)
    fresh = await tools.freshness(db)
    home = await get_config(db, "home")

    # 1) Deterministic safety layer — always first, independent of the AI.
    crit = [tools.incident_brief(i) for i in snap.get("incidents", []) if i["state"] == "active" and i["severity"] == "critical"]
    pre = safety.preamble(text, crit)
    if pre:
        yield ev("safety", text=pre)

    history = await _history(db, conv, st.aura_history_turns * 2)
    db.add(AuraMessage(conversation_id=conv.id, role="user", text=text, meta={"language": language, "voice": voice}))
    conv.updated_at = utcnow()

    provider = providers.get_provider()
    if provider is None:
        yield ev("unavailable", reason=providers.status().get("reason", "AI not configured"), conversation_id=conv.id)
        return

    usable = tools.tools_for(user, voice)
    specs = [t.spec() for t in usable]
    system = prompts.system_prompt(home.get("timezone", "Asia/Kolkata"), language, voice, page, user.name, user.role.value)
    messages: list[dict] = history + [{"role": "user", "content": [{"type": "text", "text": text}]}]
    ctx = tools.Ctx(db=db, user=user, snap=snap, freshness=fresh, actions=[])
    steps: list[str] = []
    out_text = ""
    q: asyncio.Queue = asyncio.Queue()

    async def on_text(delta: str) -> None:
        await q.put(ev("text", delta=delta))

    try:
        for _round in range(st.aura_max_tool_rounds + 1):
            # Run the model turn in the background and forward text deltas as they arrive.
            task = asyncio.create_task(provider.turn(system, messages, specs, on_text))
            while True:
                getter = asyncio.create_task(q.get())
                done, _ = await asyncio.wait({task, getter}, return_when=asyncio.FIRST_COMPLETED)
                if getter in done:
                    yield getter.result()
                    continue
                getter.cancel()
                break
            while not q.empty():
                yield q.get_nowait()
            turn = task.result()
            out_text += turn.text
            if turn.stop_reason == "refusal":
                yield ev("error", code="refused", message="Aura couldn't answer that. Try asking differently.")
                out_text = out_text or "(declined)"
                break
            if not turn.tool_calls:
                break
            if turn.stop_reason == "max_tokens":
                yield ev("error", code="truncated", message="The answer was cut off.")
                break
            messages.append({"role": "assistant", "content": turn.assistant_content})
            results = []
            for call in turn.tool_calls:
                tool = tools.BY_NAME.get(call.name)
                allowed = tool is not None and tool in usable
                if not allowed:
                    res, is_err = f"Tool {call.name!r} is not available to this user.", True
                else:
                    try:
                        args = tool.model.model_validate(call.input if isinstance(call.input, dict) else {})
                        res, is_err = await tool.run(ctx, args), False
                    except ValidationError as e:
                        res, is_err = json.dumps({"INVALID_INPUT": e.errors(include_url=False)[:3]}, default=str), True
                    except Exception:
                        log.exception("aura tool %s failed", call.name)
                        res, is_err = "The tool failed; tell the user the data could not be read.", True
                audit(db, "aura", user.id, f"aura.tool.{call.name}", conv.id, {"input": call.input if isinstance(call.input, dict) else str(call.input)[:200], "error": is_err}, ip)
                if tool and not is_err:
                    steps.append(tool.step)
                    yield ev("step", kind=call.name, text=tool.step)
                results.append({"type": "tool_result", "tool_use_id": call.id, "content": res if isinstance(res, str) else json.dumps(res, default=str), **({"is_error": True} if is_err else {})})
            for a in ctx.actions:
                yield ev("action", kind=a["type"], **{k: v for k, v in a.items() if k != "type"})
            ctx.actions.clear()
            messages.append({"role": "user", "content": results})
        else:
            yield ev("error", code="too_many_steps", message="Aura needed too many steps; try a simpler question.")
    except providers.ProviderError as e:
        log.warning("aura provider error %s: %s", e.code, e)
        yield ev("error", code=e.code, message=str(e))
        out_text = out_text or ""
    full = ((pre + "\n\n") if pre else "") + out_text
    db.add(AuraMessage(conversation_id=conv.id, role="assistant", text=full, meta={"steps": steps, "provider": provider.name}))
    yield ev("done", conversation_id=conv.id, text=full, provider=provider.name)


async def prune(db: AsyncSession) -> int:
    st = get_settings()
    res = await db.execute(delete(AuraConversation).where(AuraConversation.updated_at < utcnow() - timedelta(days=st.aura_retention_days)))
    return res.rowcount or 0
