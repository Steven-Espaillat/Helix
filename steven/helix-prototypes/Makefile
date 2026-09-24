.PHONY: up down generate test verify verify-postgres verify-candidate-evaluation verify-candidate-attempts verify-section-promotion verify-review-scaffold verify-human-directed-revision verify-superseding-runs

up:
	docker compose up --build

down:
	docker compose down

generate:
	cd backend && uv run python scripts/export_openapi.py
	cd frontend && npm run generate:api

test: generate
	node skills/helix-evidence-pipeline/scripts/verify-synthetic-bundle.mjs synthetic-e2e/helix-synthetic-bundle.json
	cd backend && uv run ruff check app tests scripts && uv run pytest
	cd frontend && npm run typecheck && npm run build

verify: test
	./scripts/verify-live.sh

verify-postgres:
	./scripts/verify-postgres.sh

verify-candidate-evaluation:
	./scripts/verify-candidate-evaluation.sh

verify-candidate-attempts:
	./scripts/verify-candidate-attempts.sh

verify-section-promotion:
	./scripts/verify-section-promotion.sh

verify-review-scaffold:
	./scripts/verify-review-scaffold.sh

verify-human-directed-revision:
	./scripts/verify-human-directed-revision.sh

verify-superseding-runs:
	./scripts/verify-superseding-runs.sh
