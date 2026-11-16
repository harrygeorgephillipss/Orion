# ORION documentation index

The 20 documents requested in the master brief, and where each stands.

| # | Document | Where | Status |
|---|---|---|---|
| 1 | Project overview | [../README.md](../README.md) | ✅ |
| 2 | Complete system architecture | [ARCHITECTURE.md](ARCHITECTURE.md) | ✅ (hardware part is a design) |
| 3 | Software architecture | [ARCHITECTURE.md](ARCHITECTURE.md) | ✅ |
| 4 | Backend installation | [BACKEND.md](BACKEND.md) | ✅ |
| 5 | Database setup | [BACKEND.md#database](BACKEND.md#database) | ✅ |
| 6 | API documentation | [API.md](API.md) + `/api/docs` | ✅ |
| 7 | Hardware wiring diagrams | [hardware-architecture.md](hardware-architecture.md) (pin map + power tree, proposed) | 🟡 draft — schematic drawings in Phase 3 |
| 8 | ESP32 firmware documentation | — | ⏳ Phase 3 |
| 9 | Arduino UNO firmware documentation | — | ⏳ Phase 3 |
| 10 | Sensor calibration guide | — | ⏳ Phase 3/6 (requires bench measurements) |
| 11 | SIM800C setup guide | — | ⏳ Phase 3 |
| 12 | Aura AI configuration | — | ⏳ Phase 4 |
| 13 | AI security and permissions | — | ⏳ Phase 4 (device-command permissions already in [SECURITY.md](SECURITY.md)) |
| 14 | Android build instructions | — | ⏳ Phase 5 |
| 15 | Testing procedures | [TESTING.md](TESTING.md) | ✅ for Phases 1–2 |
| 16 | Troubleshooting guide | — | ⏳ grows with Phase 3 (hardware) |
| 17 | Deployment guide | [DEPLOYMENT.md](DEPLOYMENT.md) | ✅ (TLS untested) |
| 18 | Hardware bill of materials | [hardware-architecture.md](hardware-architecture.md) (power section lists the extra parts) | 🟡 full BOM in Phase 3 |
| 19 | Known limitations | [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) | ✅ |
| 20 | Emergency operation and safety limitations | [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), [hardware-architecture.md](hardware-architecture.md) | 🟡 design only until firmware exists |

Also: [AUDIT_AND_PLAN.md](AUDIT_AND_PLAN.md) (audit + approved plan), [SECURITY.md](SECURITY.md),
[HANDOFF.md](HANDOFF.md) (state of work for the next session), device protocol in
[../hardware/communication/PROTOCOL.md](../hardware/communication/PROTOCOL.md).
