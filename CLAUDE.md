## Workflow Orchestration

### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One tack per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimat Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Project Facts

- Repo: https://github.com/ghkim887/karaoke-search (public, MIT, default branch `main`)
- Stack: pnpm + TypeScript + Astro + MiniSearch (frontend); cheerio + undici + wanakana + robots-parser (crawler); Biome, Vitest, Playwright. Hosted on Cloudflare Pages.
- v1 primary data source: https://j-pop-playlist.tistory.com — artist summary posts. Parser contract in design spec.
- Spec & plan: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md`

## Git Conventions

- Conventional-commit prefixes: `docs:`, `chore:`, `feat:`, `fix:`, `refactor:`, `test:`.
- Commit body via HEREDOC; include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
- Stage paths explicitly. Never `git add -A` or `git add .`.
- Default branch `main`. Push to `origin`.

## Orchestration (Project Rule)

- Main thread is orchestrator only. Delegate every work item to a specialized agent: `executor` (code), `code-reviewer` (review), `planner` (plans/specs), `document-specialist` (external docs), `verifier` (verification evidence), `explore` (codebase search), `git-master` (git ops).
- Never self-approve. Author and review are always separate agent passes.
- Trivial single-tool calls in service of orchestration (a single Read to route work, a Write of a memory entry) are OK from the main thread; everything else delegates.