#!/usr/bin/env bash
# Builds the golden harness against the ORIGINAL Java sources (src/main/java), unmodified.
# Requires JDK 8 with JavaFX (jfxrt.jar). Fetches the needed jars from Maven Central into lib/.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
LIB="$HERE/lib"
OUT="$HERE/out"
JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/jdk-1.8.0_441-oracle-x64}"

mkdir -p "$LIB" "$OUT"

fetch() { # group artifact version
  local path="${1//.//}/$2/$3/$2-$3.jar"
  local file="$LIB/$2-$3.jar"
  [ -f "$file" ] || curl -sSfL "https://repo1.maven.org/maven2/$path" -o "$file"
}
fetch org.apache.commons commons-lang3 3.5
fetch org.apache.logging.log4j log4j-api 2.8.2
fetch org.apache.logging.log4j log4j-core 2.8.2
fetch org.jdom jdom2 2.0.6

CP="$(ls "$LIB"/*.jar | tr '\n' ':')"

SOURCES=$(find "$REPO/src/main/java/sk/uniza/fri/cp/CPUEmul" "$REPO/src/main/java/sk/uniza/fri/cp/Bus" \
  "$REPO/src/main/java/sk/uniza/fri/cp/SchematicSim" -name '*.java')

"$JAVA_HOME/bin/javac" -nowarn -encoding UTF-8 -source 1.8 -target 1.8 -cp "$CP" -d "$OUT" \
  $SOURCES "$REPO/src/main/java/sk/uniza/fri/cp/App/CPUControl/DataRepresentation.java" \
  "$HERE/src/GoldenHarness.java" "$HERE/src/Json.java" "$HERE/src/ReprDump.java" "$HERE/src/SchematicGolden.java"

echo "Built into $OUT"
