#!/bin/sh
set -e
command -v anyhost >/dev/null || exit 0
anyhost herdr uninstall
