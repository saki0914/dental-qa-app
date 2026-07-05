# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

ARG CODEX_VERSION=0.142.5
ARG HTTP_SERVER_VERSION=14.1.1

USER root

RUN npm install -g "@openai/codex@${CODEX_VERSION}" "http-server@${HTTP_SERVER_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /home/node/.codex \
    && chown -R node:node /home/node/.codex \
    && chmod 700 /home/node/.codex

USER node

WORKDIR /workspaces/dental-qa-app
