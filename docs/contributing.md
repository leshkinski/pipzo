# Contributing

Pipzo is early private implementation work. Keep changes small, issue-linked, and easy to validate.

## Repository Layout

```text
backend/        FastAPI backend, contracts, persistence, auth/session logic, tests
frontend/       React/Vite/TypeScript kiosk UI, API helpers, view models, tests
provisioning/   Raspberry Pi OS, systemd, Chromium kiosk, Wi-Fi, Bluetooth setup work
docs/           Architecture, product scope, setup, contribution, and planning docs
scripts/        Local developer and maintenance scripts
data/           Local generated SQLite/key material; ignored by Git
.github/        Issue templates and GitHub workflow metadata
```

MyOS project controls, dispatches, and handoffs live outside this implementation repo in `Active Work/Pipzo`. Do not copy MyOS control files into this repo; link to GitHub Issues from implementation docs when backlog context is needed.

## Local Setup

Backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
PIPZO_MODE=mock uvicorn pipzo_api.main:app --app-dir backend --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to `http://127.0.0.1:8000`.

For Spotify setup, copy `.env.example` to `.env`, set `SPOTIFY_CLIENT_ID`, and follow [Spotify Developer Setup](spotify-developer-setup.md).

## Validation

Run the smallest complete set relevant to the change. For normal backend/frontend slices, use:

```bash
.venv/bin/python -m pytest
cd frontend && npm run typecheck
cd frontend && npm test
cd frontend && npm run build
git diff --check
```

For documentation-only changes, at minimum run:

```bash
git diff --check
```

Also verify changed Markdown links manually unless a docs link checker exists.

## Commit Hygiene

- Keep commits focused on one issue or coherent slice.
- Reference GitHub Issues in commit messages when useful, for example `docs: close spotify setup docs (#5)`.
- Do not commit `.env`, token keys, SQLite databases, build output, dependency folders, logs, OAuth codes, refresh tokens, access tokens, PKCE verifiers, callback URLs with query strings, or local secrets.
- Prefer one focused commit after validation passes. Split mixed work before committing when review would be unclear.
- Leave generated local files ignored.

## GitHub Issue Sync

GitHub Issues are canonical for implementation backlog. For each completed slice:

- Comment with what changed, validation run, commit hash, and any skipped/deferred work.
- Close the issue when the acceptance criteria are satisfied.
- Leave the issue open with a precise remaining checklist when work is incomplete.

## Documentation Standards

- Keep `README.md` as the concise project entry point.
- Put detailed setup and operational notes in `docs/`.
- Keep architecture notes in `docs/architecture.md` and product boundaries in `docs/product-scope.md`.
- Keep sensitive-surface notes explicit when docs mention auth, secrets, tokens, local keys, Wi-Fi credentials, or external integrations.
- Do not duplicate MyOS project controls or specialist handoffs in this repo.
