FROM mcr.microsoft.com/devcontainers/base:ubuntu

RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    git-delta \
    locales \
 && localedef -i en_US -f UTF-8 UTF-8

WORKDIR /workspaces/tokendashboard-plugin-claude

USER vscode
