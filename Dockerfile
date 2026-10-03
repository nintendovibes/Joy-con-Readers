# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app

# Reproducible install from the lockfile
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Build the static site (outputs to /app/dist)
COPY . .
RUN npm run build

# ---- Runtime stage ----
# nginx-unprivileged listens on 8080 and runs as non-root, which is required
# for OpenShift's restricted-v2 SCC (containers run under an arbitrary UID).
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# nginx's stock entrypoint renders *.template files from /etc/nginx/templates
# through envsubst into /etc/nginx/conf.d at startup, substituting ${API_UPSTREAM}.
# That start-time render is why an env-var change (which rolls a new pod) is
# what picks up a new backend address.
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template

# Static build output
COPY --from=build /app/dist /usr/share/nginx/html

# Make runtime-writable paths group-writable so an arbitrary OpenShift UID
# (always in supplemental group 0) can write the rendered config / pid / cache.
USER 0
RUN chgrp -R 0 /etc/nginx/conf.d /var/cache/nginx /tmp \
 && chmod -R g+rwX /etc/nginx/conf.d /var/cache/nginx /tmp
USER 101

# Benign default so the image still starts standalone; the Deployment's
# API_UPSTREAM env var is the authoritative value.
ENV API_UPSTREAM=http://127.0.0.1:8001

EXPOSE 8080
# Base image's ENTRYPOINT/CMD (envsubst render + nginx) are inherited as-is.
