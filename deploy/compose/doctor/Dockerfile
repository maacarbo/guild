# syntax=docker/dockerfile:1
# Guild doctor — one-shot diagnostics for the Tier 1 stack.
# Runs in a Linux container so the host OS never matters (cross-platform
# ruling, ROADMAP M1a): the single implementation IS the Windows version.
FROM alpine:3.22

RUN apk add --no-cache bash curl jq

COPY doctor.sh /usr/local/bin/doctor.sh
RUN chmod 755 /usr/local/bin/doctor.sh && adduser -D -u 1001 doctor
USER doctor

ENTRYPOINT ["/usr/local/bin/doctor.sh"]
