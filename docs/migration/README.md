# CPUEmulSim — Web Migration with LDAP

Functional migration of the JavaFX desktop application to a web application with LDAP/AD authentication. Behaviour must stay identical. Source brief: [prompts/init.md](../../prompts/init.md).

**Reference version: upstream `v0.9.4`** (moved from 0.9.2 on 2026-10-11; Java sources on branch `upgrade-0.9.4`). The CPU side is unchanged; the schematic editor gained a new wire model, a 10 px grid, and new component features (see 01, sections marked 0.9.4).

| Phase | Document | Status |
|---|---|---|
| 1 — Repository analysis | [01-repository-understanding.md](01-repository-understanding.md) | Done |
| 2 — Functional specification | [02-functional-specification.md](02-functional-specification.md) | Done |
| 3 — Migration design | [03-migration-design.md](03-migration-design.md) | Done; D1–D4 and D6–D10 approved 2026-10-09; **D5 (LDAP connection details) open** |
| 4 — Implementation | `web-app/` | Ported to 0.9.4; engine golden tests (CPU + 8 schematic scenarios) green against Java 0.9.4. LDAP can be switched off for local runs (`auth.mode: none`) |
| 5 — Verification | [04-test-plan.md](04-test-plan.md) defines the checklists; results are recorded per row | Plan done |
| Deployment | [../deployment.md](../deployment.md) - server setup (systemd + nginx + HTTPS, optional LDAP); files in `web-app/deploy/` | Example ready |

Key findings:

- The original has **no authentication and no server**. LDAP is purely additive. Until LDAP is connected, `auth.mode: local` provides registration and password login with a per-user file workspace (D11).
- **Hardware interrupts** were unreachable in 0.9.2 (output-only `IT` tap). 0.9.4 fixed this, so the web version raises interrupts from the circuit. The other quirks are preserved by default (D8), including three new in 0.9.4 (#17–#19: free-end wires vanish on reload, old files shift, overlapping palette drops).
- `.schx` files embed Java class names, so the web version maps them in both directions to stay file-compatible with the desktop version.
- **Approved deviation D2:** files are saved to the user's account on the server (flat list on the filesystem), with a browser draft autosave in IndexedDB. Only the native file dialogs are replaced; the prompts and Save semantics stay the same.
- The emulator stays **client-side** (TypeScript port, golden-tested against the Java original). The backend handles only authentication and sessions.
