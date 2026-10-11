#!/usr/bin/env bash
# Records golden fixtures from the original Java engine: corpus/*.asm -> golden/*.json
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$HERE/../../packages/engine/test"
JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/jdk-1.8.0_441-oracle-x64}"
"$HERE/build.sh" >/dev/null
node "$HERE/gen-opcodes.mjs"
CP="$HERE/out:$(ls "$HERE"/lib/*.jar | tr '\n' ':')"
"$JAVA_HOME/bin/java" -Dfile.encoding=UTF-8 -cp "$CP" sk.uniza.fri.cp.CPUEmul.GoldenHarness "$ENGINE/corpus" "$ENGINE/golden" 2>"$HERE/record.stderr.log"
mkdir -p "$ENGINE/golden-misc"
"$JAVA_HOME/bin/java" -cp "$CP" sk.uniza.fri.cp.App.CPUControl.ReprDump "$ENGINE/golden-misc/representation.json"
"$JAVA_HOME/bin/java" -Dfile.encoding=UTF-8 -cp "$CP" sk.uniza.fri.cp.SchematicSim.Sheet.SchematicGolden "$ENGINE/golden-schematic" 2>>"$HERE/record.stderr.log"
