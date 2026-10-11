package sk.uniza.fri.cp.CPUEmul;

import com.sun.javafx.application.PlatformImpl;
import javafx.scene.input.KeyCode;
import javafx.scene.input.KeyEvent;
import sk.uniza.fri.cp.Bus.Bus;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;

/**
 * Golden-master recorder. Drives the ORIGINAL, unmodified {@link Parser} and {@link CPU}
 * classes and writes JSON fixtures that the TypeScript engine must reproduce exactly.
 * <p>
 * Lives in package {@code sk.uniza.fri.cp.CPUEmul} only to read package-private program
 * structure; it never changes production behaviour.
 * <p>
 * Usage: {@code GoldenHarness <corpusDir> <outDir>}. For every {@code X.asm} the optional
 * {@code X.keys} file scripts keyboard input, one event per line:
 * <pre>
 *   wait char a        feed when the CPU enters Waiting (SCALL KEY)
 *   wait arrow LEFT
 *   @5 char x          feed before resuming from halt #5
 * </pre>
 */
public final class GoldenHarness {

    private static final int MAX_HALTS = 5000;
    private static final long SEED = 20261009L;

    public static void main(String[] args) throws Exception {
        File corpus = new File(args[0]);
        File out = new File(args[1]);
        out.mkdirs();

        // Parser is a JavaFX Task: updateProgress() needs a running toolkit
        CountDownLatch fx = new CountDownLatch(1);
        PlatformImpl.startup(fx::countDown);
        fx.await();

        File[] files = corpus.listFiles((dir, name) -> name.endsWith(".asm"));
        if (files == null) throw new IOException("No corpus at " + corpus);
        Arrays.sort(files);

        for (File asm : files) {
            String name = asm.getName().substring(0, asm.getName().length() - 4);
            Map<String, Object> fixture = record(asm);
            Files.write(new File(out, name + ".json").toPath(),
                    Json.write(fixture).getBytes(StandardCharsets.UTF_8));
            System.out.println("recorded " + name);
        }
        System.exit(0);
    }

    // ------------------------------------------------------------------ recording

    private static Map<String, Object> record(File asm) throws Exception {
        // same as CPUController.handleMenuFileOpenAction: every line + "\n"
        StringBuilder sb = new StringBuilder();
        for (String line : Files.readAllLines(asm.toPath(), StandardCharsets.UTF_8)) sb.append(line).append('\n');
        String code = sb.toString();

        Map<String, Object> fixture = new LinkedHashMap<>();
        fixture.put("code", code);

        Map<String, Object> parse = new LinkedHashMap<>();
        Program program = parse(code, parse);
        fixture.put("parse", parse);

        List<Object> runs = new ArrayList<>();
        if (program != null) {
            List<String[]> script = readKeys(new File(asm.getParentFile(), asm.getName().replace(".asm", ".keys")));
            String mode = "auto";
            List<Integer> breakLines = new ArrayList<>();
            List<String[]> keys = new ArrayList<>();
            for (String[] line : script) {
                if (line[0].equals("mode")) mode = line[1];
                else if (line[0].equals("breaks")) {
                    for (int i = 1; i < line.length; i++) for (String n : line[i].split(" ")) breakLines.add(Integer.parseInt(n));
                } else keys.add(line);
            }
            if (!mode.equals("micro")) runs.add(run(program, false, true, keys, breakLines));
            if (mode.equals("micro") || (mode.equals("auto") && program.hasIOInstruction()))
                runs.add(run(program, true, true, keys, breakLines));
        }
        fixture.put("runs", runs);
        return fixture;
    }

    private static Program parse(String code, Map<String, Object> parse) throws Exception {
        // CPUController: number of paragraphs of the editor = number of '\n' + 1
        int lines = 1;
        for (int i = 0; i < code.length(); i++) if (code.charAt(i) == '\n') lines++;

        Parser parser = new Parser(code, lines);
        parser.run();
        try {
            Program program = parser.get();
            parse.put("ok", true);
            parse.put("program", describe(program));
            return program;
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            parse.put("ok", false);
            parse.put("exception", cause.getClass().getSimpleName());
            if (cause instanceof sk.uniza.fri.cp.CPUEmul.Exceptions.InvalidCodeLinesException) {
                sk.uniza.fri.cp.CPUEmul.Exceptions.InvalidCodeLinesException ex =
                        (sk.uniza.fri.cp.CPUEmul.Exceptions.InvalidCodeLinesException) cause;
                parse.put("errorLines", ex.getLines());
                parse.put("errors", Arrays.asList(ex.getErrors()));
            }
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> describe(Program program) throws Exception {
        Map<String, Object> d = new LinkedHashMap<>();
        List<Object> instructions = new ArrayList<>();
        for (int i = 0; ; i++) {
            Instruction inst = program.getInstruction(i);
            if (inst == null) break;
            instructions.add(Arrays.asList(inst.getType().name(), inst.getFirstParameter(), inst.getSecondParameter()));
        }
        d.put("instructions", instructions);

        List<Object> memory = new ArrayList<>();
        for (byte b : program.getMemory()) memory.add((int) b);
        d.put("memory", memory);

        d.put("lineToInstruction", new TreeMap<>((Map<Integer, Integer>) field(program, "lineIndexToInstructionIndex")));
        d.put("interruptLabels", new TreeMap<>((Map<Integer, Integer>) field(program, "interruptionLabels")));
        d.put("hasIO", program.hasIOInstruction());
        return d;
    }

    private static Map<String, Object> run(Program program, boolean microstep, boolean intLevel,
                                           List<String[]> keys, List<Integer> breakLines) throws Exception {
        javafx.collections.ObservableSet<Integer> breaks = javafx.collections.FXCollections.observableSet(new java.util.TreeSet<>(breakLines));
        program.removeListenerOnBreakpointsChange(breaks);
        program.setListenerOnBreakpointsChange(breaks);
        Bus bus = Bus.getBus();
        setField(bus, "rand", new Random(SEED));
        bus.reset();

        List<Object> busEvents = Collections.synchronizedList(new ArrayList<>());
        javafx.beans.value.ChangeListener<Number> onAddress = (o, a, b) -> busEvents.add(Arrays.asList("A", b.intValue()));
        javafx.beans.value.ChangeListener<Number> onData = (o, a, b) -> busEvents.add(Arrays.asList("D", b.intValue()));
        javafx.beans.value.ChangeListener<Number> onControl = (o, a, b) -> busEvents.add(Arrays.asList("C", b.intValue()));
        bus.addressBusProperty().addListener(onAddress);
        bus.dataBusProperty().addListener(onData);
        bus.controlBusProperty().addListener(onControl);

        List<Object> console = Collections.synchronizedList(new ArrayList<>());
        OutputStream consoleStream = new OutputStream() {
            @Override public void write(int b) { console.add(Arrays.asList("i", b)); }
            @Override public void write(byte[] b) {
                List<Integer> bytes = new ArrayList<>();
                for (byte x : b) bytes.add((int) x);
                console.add(Arrays.asList("a", bytes));
            }
        };

        CPU cpu = new CPU(consoleStream, bus);
        cpu.setDaemon(true);
        cpu.start();
        cpu.setIntLevel(intLevel);
        cpu.setMicrostep(microstep);
        waitHalted(cpu, null, CPUStates.Idle);

        busEvents.clear();
        cpu.reset();
        cpu.loadProgram(program);
        long t0 = System.currentTimeMillis();
        Object latch = field(cpu, "cdlHalt");
        cpu.startExecute(true); // = Step [F7] from Idle

        List<Object> halts = new ArrayList<>();
        byte[] prevRam = new byte[256];
        byte[] prevStack = new byte[65536];
        int keyIndex = 0;
        String endReason = "limit";

        for (int halt = 0; halt < MAX_HALTS; halt++) {
            latch = waitHalted(cpu, latch, null);
            CPUStates state = (CPUStates) cpu.stateProperty().getValue();

            Map<String, Object> snap = snapshot(cpu, state, prevRam, prevStack);
            synchronized (busEvents) {
                snap.put("bus", new ArrayList<>(busEvents));
                busEvents.clear();
            }
            synchronized (console) {
                snap.put("console", new ArrayList<>(console));
                console.clear();
            }
            snap.put("t", System.currentTimeMillis() - t0);
            halts.add(snap);

            if (state == CPUStates.Idle) { endReason = "idle"; break; }

            if (state == CPUStates.Waiting) {
                String[] key = nextKey(keys, keyIndex, "wait");
                if (key == null) {
                    endReason = "waiting-no-key";
                    cpu.stopExecute();
                    waitHalted(cpu, latch, CPUStates.Idle);
                    Map<String, Object> last = snapshot(cpu, (CPUStates) cpu.stateProperty().getValue(), prevRam, prevStack);
                    synchronized (busEvents) { last.put("bus", new ArrayList<>(busEvents)); busEvents.clear(); }
                    synchronized (console) { last.put("console", new ArrayList<>(console)); console.clear(); }
                    last.put("t", System.currentTimeMillis() - t0);
                    halts.add(last);
                    break;
                }
                keyIndex++;
                cpu.setKeyPressed(keyEvent(key));
                long until = System.currentTimeMillis() + 10000;
                while (cpu.stateProperty().getValue() == CPUStates.Waiting && System.currentTimeMillis() < until) {
                    Thread.sleep(0, 200_000);
                }
                continue;
            }

            boolean controlled = false;
            String[] scheduled;
            while ((scheduled = nextKey(keys, keyIndex, "@" + halt)) != null) {
                keyIndex++;
                if ("stop".equals(scheduled[1])) { cpu.stopExecute(); controlled = true; }
                else if ("continue".equals(scheduled[1])) { cpu.continueExecute(); controlled = true; }
                else cpu.setKeyPressed(keyEvent(scheduled));
            }
            if (!controlled) cpu.step();
        }
        if ("limit".equals(endReason)) cpu.stopExecute();
        cpu.cancel();
        cpu.join(5000);
        bus.addressBusProperty().removeListener(onAddress);
        bus.dataBusProperty().removeListener(onData);
        bus.controlBusProperty().removeListener(onControl);

        Map<String, Object> run = new LinkedHashMap<>();
        run.put("microstep", microstep);
        run.put("intLevel", intLevel);
        run.put("seed", SEED);
        run.put("halts", halts);
        run.put("endReason", endReason);
        return run;
    }

    /** Waits until the CPU thread is blocked on a NEW halt latch, or enters the expected/Waiting state. */
    private static Object waitHalted(CPU cpu, Object previousLatch, CPUStates expected) throws Exception {
        long deadline = System.currentTimeMillis() + 10000;
        while (System.currentTimeMillis() < deadline) {
            Object latch = field(cpu, "cdlHalt");
            CPUStates state = (CPUStates) cpu.stateProperty().getValue();
            if (state == CPUStates.Waiting && expected == null) {
                Thread.sleep(2); // let it settle in semKey.acquire()
                return previousLatch;
            }
            if (latch != null && latch != previousLatch && (expected == null || state == expected)) {
                return latch;
            }
            Thread.sleep(0, 200_000);
        }
        throw new IllegalStateException("CPU did not halt");
    }

    private static Map<String, Object> snapshot(CPU cpu, CPUStates state, byte[] prevRam, byte[] prevStack) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("state", state.name());
        s.put("message", cpu.getMessage());
        s.put("pc", Short.toUnsignedInt(cpu.getRegPC()));
        s.put("a", Byte.toUnsignedInt(cpu.getRegA()));
        s.put("b", Byte.toUnsignedInt(cpu.getRegB()));
        s.put("c", Byte.toUnsignedInt(cpu.getRegC()));
        s.put("d", Byte.toUnsignedInt(cpu.getRegD()));
        s.put("sp", Short.toUnsignedInt(cpu.getRegSP()));
        s.put("mp", Short.toUnsignedInt(cpu.getRegMP()));
        s.put("cy", cpu.isFlagCY());
        s.put("z", cpu.isFlagZ());
        s.put("ie", cpu.isFlagIE());
        s.put("ram", diff(cpu.getRAM(), prevRam));
        s.put("stack", diff(cpu.getStack(), prevStack));
        return s;
    }

    private static List<Object> diff(byte[] now, byte[] prev) {
        List<Object> changes = new ArrayList<>();
        for (int i = 0; i < now.length; i++) {
            if (now[i] != prev[i]) {
                changes.add(Arrays.asList(i, Byte.toUnsignedInt(now[i])));
                prev[i] = now[i];
            }
        }
        return changes;
    }

    // ------------------------------------------------------------------ keys

    private static List<String[]> readKeys(File file) throws IOException {
        List<String[]> keys = new ArrayList<>();
        if (!file.exists()) return keys;
        for (String line : Files.readAllLines(file.toPath(), StandardCharsets.UTF_8)) {
            if (line.trim().isEmpty() || line.startsWith("#")) continue;
            keys.add(line.split(" ", 3));
        }
        return keys;
    }

    private static String[] nextKey(List<String[]> keys, int index, String when) {
        if (index >= keys.size()) return null;
        return keys.get(index)[0].equals(when) ? keys.get(index) : null;
    }

    private static KeyEvent keyEvent(String[] key) {
        if ("arrow".equals(key[1])) {
            // App.java forwards KEY_PRESSED for arrow keys
            return new KeyEvent(KeyEvent.KEY_PRESSED, KeyEvent.CHAR_UNDEFINED, "", KeyCode.valueOf(key[2]),
                    false, false, false, false);
        }
        String ch = "space".equals(key[2]) ? " " : "enter".equals(key[2]) ? "\r" : key[2];
        // App.java / SchematicController forward KEY_TYPED for characters
        return new KeyEvent(KeyEvent.KEY_TYPED, ch, "", KeyCode.UNDEFINED, false, false, false, false);
    }

    // ------------------------------------------------------------------ reflection

    private static Object field(Object target, String name) throws Exception {
        Field f = target.getClass().getDeclaredField(name);
        f.setAccessible(true);
        return f.get(target);
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        Field f = target.getClass().getDeclaredField(name);
        f.setAccessible(true);
        f.set(target, value);
    }
}
