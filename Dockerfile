FROM node:22-slim
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
COPY . /app
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --dangerously-allow-all-builds && \
    pnpm run build && \
    pnpm prune --prod
EXPOSE 3000
CMD [ "pnpm", "start" ]
