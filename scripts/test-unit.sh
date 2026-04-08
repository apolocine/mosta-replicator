#!/bin/bash
# @mostajs/replicator — Tests unitaires (SQLite :memory:)
# Author: Dr Hamid MADANI drmdh@msn.com
# Usage: bash scripts/test-unit.sh
set -e

cd "$(dirname "$0")/.."
echo ""
echo "════════════════════════════════════════"
echo "  @mostajs/replicator — Tests unitaires"
echo "════════════════════════════════════════"
echo ""

echo "▶ Build..."
npx tsc 2>&1
echo "  ✅ Build OK"
echo ""

npx tsx scripts/test-unit.ts
