.PHONY: help up dev staging up-nginx down logs logs-api logs-postgres pull migrate grants psql redis-cli test status health clean

help:
	@echo "Codex Platform — Docker commands"
	@echo ""
	@echo "  make up           Start production (pull from GHCR)"
	@echo "  make dev          Start local dev (build from source)"
	@echo "  make staging      Start staging environment"
	@echo "  make up-nginx     Start production with nginx reverse proxy"
	@echo "  make down         Stop all services"
	@echo "  make logs         Tail all logs"
	@echo "  make logs-api     Tail API logs only"
	@echo "  make pull         Pull latest image from GHCR"
	@echo "  make migrate      Run database migrations manually"
	@echo "  make psql         Open PostgreSQL shell"
	@echo "  make redis-cli    Open Redis CLI"
	@echo "  make test         Run API test suite"
	@echo "  make status       Show container status + health"
	@echo "  make health       Check API /health endpoint"
	@echo "  make grants       Re-apply app_runtime table grants (existing containers)"
	@echo "  make clean        Remove all containers and volumes (destructive)"

up:
	docker compose pull
	docker compose up -d
	@echo "API: http://localhost:3000"

dev:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

staging:
	docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d

up-nginx:
	docker compose --profile nginx up -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

logs-api:
	docker compose logs -f --tail=100 api

logs-postgres:
	docker compose logs -f --tail=50 postgres

pull:
	docker compose pull api

migrate:
	docker compose exec api sh -c 'for f in $$(ls apps/api/migrations/*.sql | sort); do \
	  echo "Applying $$f..."; \
	  psql "$$DATABASE_URL" -f "$$f" 2>/dev/null || true; \
	done'

grants:
	docker compose exec -T postgres psql -U codex -d codex <<'SQL'
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO app_runtime;
SELECT 'Grants applied: ' || count(*) || ' tables' FROM information_schema.tables WHERE table_schema = 'public';
SQL

psql:
	docker compose exec postgres psql -U codex -d codex

redis-cli:
	docker compose exec redis redis-cli

test:
	docker compose exec api npm test --workspace=apps/api

status:
	docker compose ps
	@echo ""
	@curl -s http://localhost:3000/health 2>/dev/null | python3 -m json.tool || echo "API not responding"

health:
	@curl -s http://localhost:3000/health | python3 -m json.tool

clean:
	docker compose down -v --remove-orphans
	docker image rm codex-api:dev 2>/dev/null || true
	@echo "Containers and volumes removed"
