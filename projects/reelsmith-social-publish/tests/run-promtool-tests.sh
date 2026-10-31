#!/bin/sh
# Runs the promtool unit tests (*.test.yml) in this directory against the Reelsmith alert
# rules. Modelled on homelab-infra's monitoring/tests/run-promtool-tests.sh. promtool reads
# plain rule groups, not PrometheusRule objects, so the .spec of
# ../manifests/reelsmith-alerts-prometheusrule.yaml (synced by ArgoCD) is first extracted to
# reelsmith-alerts.yml next to a copy of the tests. `promtool check rules` lints it and the
# hand-applied drill rule (../manifests/test/reelsmith-drill.yaml), then
# `promtool test rules` runs every test file. Needs yq (mikefarah v4) and docker; touches no
# cluster. From the repo root (CI runs exactly this):
#   sh projects/reelsmith-social-publish/tests/run-promtool-tests.sh
# The image is prom/prometheus:v3.10.0, the live Prometheus version (Prometheus CR
# spec.version, checked 2026-10-31), pinned by its multi-arch index digest so CI and an
# arm64 Mac run the same build. PROMTOOL_IMAGE overrides it.
set -eu
image="${PROMTOOL_IMAGE:-prom/prometheus:v3.10.0@sha256:4a61322ac1103a0e3aea2a61ef1718422a48fa046441f299d71e660a3bc71ae9}"
here="$(cd "$(dirname "$0")" && pwd)"
case "$(yq --version 2>&1)" in
    *mikefarah*" v4."*) ;;
    *) echo "run-promtool-tests: needs mikefarah yq v4 (found: $(yq --version 2>&1))" >&2; exit 2 ;;
esac
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
yq '.spec' "$here/../manifests/reelsmith-alerts-prometheusrule.yaml" > "$tmp/reelsmith-alerts.yml"
yq '.spec' "$here/../manifests/test/reelsmith-drill.yaml" > "$tmp/reelsmith-drill.yml"
cp "$here"/*.test.yml "$tmp/"
cd "$tmp"
# The image runs as nobody, and mktemp's directory is 0700: run promtool as the caller so it
# can read the mount on Linux (Docker Desktop on macOS hides the difference).
user="$(id -u):$(id -g)"
docker run --rm --user "$user" -v "$tmp":/t:ro -w /t --entrypoint promtool "$image" \
    check rules reelsmith-alerts.yml reelsmith-drill.yml
# shellcheck disable=SC2046 # one argument per test file; the names have no spaces
docker run --rm --user "$user" -v "$tmp":/t:ro -w /t --entrypoint promtool "$image" \
    test rules $(ls -- *.test.yml)
