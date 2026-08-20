rebuild-devcontainer:
    @DOCKER_CLI_HINTS=false devcontainer up --remove-existing-container --build-no-cache

_up:
    @if ! docker ps -q -f name=tokendashboard-plugin-claude-dev | grep -q .; then \
        echo "Starting devcontainer..."; \
        devcontainer up; \
    elif ! docker exec tokendashboard-plugin-claude-dev true >/dev/null 2>&1; then \
        echo "Devcontainer reports Up but its mount namespace is stale (Docker daemon likely restarted under it); restarting..."; \
        docker restart tokendashboard-plugin-claude-dev >/dev/null; \
        if ! docker exec tokendashboard-plugin-claude-dev true >/dev/null 2>&1; then \
            echo "Restart did not clear it; recreating container..."; \
            devcontainer up --remove-existing-container; \
        fi; \
    fi

_agent $HERDR_AGENT command: _up
    @DOCKER_CLI_HINTS=false devcontainer exec -- {{command}}

claude: (_agent "claude" "claude --dangerously-skip-permissions")
