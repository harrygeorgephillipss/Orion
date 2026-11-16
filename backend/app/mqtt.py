"""MQTT connection: consumes device messages and publishes commands. Reconnects with back-off."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import ssl

import aiomqtt

from .bus import bus
from .config import get_settings
from .db import sessionmaker
from .services import commands, ingest

log = logging.getLogger("orion.mqtt")


class MqttState:
    connected: bool = False
    last_error: str | None = None
    received: int = 0
    rejected: int = 0


state = MqttState()


async def run() -> None:
    st = get_settings()
    backoff = 1.0
    while True:
        try:
            tls = ssl.create_default_context() if st.mqtt_tls else None
            async with aiomqtt.Client(
                hostname=st.mqtt_host, port=st.mqtt_port, username=st.mqtt_username or None, password=st.mqtt_password or None,
                tls_context=tls, identifier=f"orion-backend-{st.home_id}-{os.getpid()}-{secrets.token_hex(3)}", keepalive=30,  # unique: duplicate ids kick each other off
            ) as client:
                await client.subscribe(f"{st.mqtt_topic_root}/+/+/+", qos=1)
                state.connected, state.last_error, backoff = True, None, 1.0

                async def publish(topic: str, payload: bytes) -> None:
                    await client.publish(topic, payload, qos=1)

                commands.set_publisher(publish)
                bus.publish("server_status", mqtt=True)
                log.info("MQTT connected to %s:%s", st.mqtt_host, st.mqtt_port)
                async for msg in client.messages:
                    topic = str(msg.topic)
                    if topic.endswith("/cmd"):
                        continue  # our own outgoing commands
                    state.received += 1
                    async with sessionmaker()() as db:
                        try:
                            await ingest.handle(db, topic, msg.payload, root=st.mqtt_topic_root, retained=bool(msg.retain))
                            await db.commit()
                        except ingest.IngestError as e:
                            await db.rollback()
                            state.rejected += 1
                            log.warning("rejected %s: %s", topic, e)
                        except Exception:
                            await db.rollback()
                            state.rejected += 1
                            log.exception("ingest failure on %s", topic)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # broker unreachable, auth failure…
            commands.set_publisher(None)
            if state.connected:
                bus.publish("server_status", mqtt=False)
            state.connected, state.last_error = False, f"{type(e).__name__}: {e}"
            log.warning("MQTT disconnected (%s); retrying in %.0fs", state.last_error, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


def dumps(o: object) -> bytes:
    return json.dumps(o, separators=(",", ":")).encode()
