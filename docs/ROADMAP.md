# Socius2 — Build Roadmap

Baseline: **195/195 tests passing** (`npm test`), established in Phase 0.

| Phase | Agents | Status |
|---|---|---|
| P0 Foundation | — | ✅ complete |
| W1 Platform | A01–A10 | ⬜ |
| W2 AI core | A11–A20 | ⬜ |
| W3 Pages | A21–A30 | ⬜ |
| W4 Features | A31–A40 | ⬜ |
| W5 Extension+polish | A41–A50 | ⬜ |
| P6 Integration | I01–I02 | ⬜ |
| P7 Test | T01–T05 | ⬜ |

## Wave gate rule
Do not start wave N+1 until wave N reports green AND `npm test` ≥ baseline (195).

## ⚠️ How to load a skill (IMPORTANT — affects every agent)

52 skills are installed at `~/.agents/skills/<name>/SKILL.md` and registered in
`~/.agents/.skill-lock.json`. **The `skill` tool does NOT reliably see them** — its
session registry was snapshotted mid-install and only exposes ~13 of the 52, so
`skill(id=...)` returns "Unable to load skill" for most names.

**Do this instead — it is authoritative and always works:**

```bash
cat ~/.agents/skills/<skill-name>/SKILL.md
# plus any referenced files in that directory
ls ~/.agents/skills/<skill-name>/
```

If `skill` happens to work for a name, fine. If it errors, **fall back to the file
immediately** — do not report the skill as missing. A09 hit this and recovered
correctly by following AGENTS.md conventions.

Full list of installed skills: `ls ~/.agents/skills/`

## Non-negotiables (from AGENTS.md)
- Vanilla JS / Express / ChromaDB / NIM. No frameworks without approval.
- Keys stay backend-side. Browser never touches Chroma or NIM directly.
- No speculative/empty modules. If it isn't implemented, it doesn't exist.
- Deterministic grading and mastery logic.
