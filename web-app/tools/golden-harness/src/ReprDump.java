package sk.uniza.fri.cp.App.CPUControl;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Dumps the ORIGINAL DataRepresentation output for every byte and a sweep of shorts. */
public final class ReprDump {
    public static void main(String[] args) throws Exception {
        Map<String, Object> out = new LinkedHashMap<>();
        for (DataRepresentation.eRepresentation rep : DataRepresentation.eRepresentation.values()) {
            List<String> bytes = new ArrayList<>();
            for (int v = -128; v < 128; v++) bytes.add(DataRepresentation.getDisplayRepresentation((byte) v, rep));
            List<String> shorts = new ArrayList<>();
            for (int v = -32768; v < 32768; v += 257) shorts.add(DataRepresentation.getDisplayRepresentation((short) v, rep));
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("bytes", bytes);
            m.put("shorts", shorts);
            out.put(rep.name(), m);
        }
        Files.write(new File(args[0]).toPath(), json(out).getBytes(StandardCharsets.UTF_8));
    }

    @SuppressWarnings("unchecked")
    private static String json(Object o) {
        if (o instanceof Map) {
            StringBuilder sb = new StringBuilder("{");
            for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                if (sb.length() > 1) sb.append(',');
                sb.append(str(e.getKey())).append(':').append(json(e.getValue()));
            }
            return sb.append('}').toString();
        }
        if (o instanceof List) {
            StringBuilder sb = new StringBuilder("[");
            for (Object x : (List<Object>) o) {
                if (sb.length() > 1) sb.append(',');
                sb.append(json(x));
            }
            return sb.append(']').toString();
        }
        return str((String) o);
    }

    private static String str(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20 || c > 0x7e) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }
}
