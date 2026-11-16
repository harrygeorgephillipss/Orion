"""Aura — ORION's assistant, served by the ORION backend (Phase 4).

Isolated module: the rest of the backend only calls `service.chat()` and the proposal endpoints. The AI provider is
configurable (AURA_PROVIDER); its API key lives only in the server environment and never reaches any client.
"""
