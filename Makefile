PNPM ?= pnpm

.PHONY: help install lint test build check clawhub-validate pack-check

help: ## Show available commands.
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "%-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install package dependencies.
	@$(PNPM) install

lint: ## Run ESLint and TypeScript static checks.
	@$(PNPM) lint
	@$(PNPM) typecheck

test: ## Run automated tests.
	@$(PNPM) test

build: ## Compile the package to dist/.
	@$(PNPM) build

check: lint test build ## Run all local quality checks.

clawhub-validate: build ## Validate the package with an installed ClawHub CLI.
	@$(PNPM) clawhub:validate

pack-check: build ## Verify the npm package contents without publishing.
	@$(PNPM) pack:check
