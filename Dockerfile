FROM denoland/deno:latest AS builder
WORKDIR /app
COPY deno.lock deno.jsonc ./
COPY ./src/ ./src/
RUN deno cache src
CMD ["deno", "task", "serve"]
