package sk.uniza.fri.cp.SchematicSim.Sheet;

import com.sun.javafx.application.PlatformImpl;
import javafx.application.Platform;
import javafx.geometry.Point2D;
import sk.uniza.fri.cp.Bus.Bus;
import sk.uniza.fri.cp.SchematicSim.Buses.AddressBus16;
import sk.uniza.fri.cp.SchematicSim.Buses.ControlBus;
import sk.uniza.fri.cp.SchematicSim.Buses.DataBus8;
import sk.uniza.fri.cp.SchematicSim.Gates.*;
import sk.uniza.fri.cp.SchematicSim.Pin.Pin;
import sk.uniza.fri.cp.SchematicSim.Wire.Wire;
import sk.uniza.fri.cp.SchematicSim.Wire.WireJunction;
import sk.uniza.fri.cp.SchematicSim.Movable;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import sk.uniza.fri.cp.CPUEmul.Json;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Golden recorder for the schematic simulator (v0.9.4 wire model, 10 px grid). Builds reference
 * circuits with the ORIGINAL classes (Wire(sheet) + WireEnd.connect + settleToGrid, branches by
 * splitAtPoint), saves them as .schx, re-loads + re-saves them (round trip) and replays scripted
 * actions (switch toggles, CPU-style bus cycles, key presses, waits, and wire edits: new wire,
 * branch, component drag + release, wire delete), recording a snapshot after each. Snapshots after
 * wire edits include the saved .schx text.
 * <p>
 * Everything touching JavaFX objects runs on the FX thread; bus cycles and steady-state waits
 * run on this (harness) thread, exactly as the CPU thread did.
 */
public final class SchematicGolden {

    private static final long SEED = 4242L;
    private static final long MATH_RANDOM_SEED = 777L;
    /** SchematicController.GRID_SIZE in 0.9.4. */
    private static final int GRID = 10;
    private static final Set<String> EDIT_OPS = new HashSet<>(Arrays.asList("wire", "branch", "drag", "dragRelease", "deleteWire"));
    private static File out;

    public static void main(String[] args) throws Exception {
        out = new File(args[0]);
        out.mkdirs();
        CountDownLatch fx = new CountDownLatch(1);
        PlatformImpl.startup(fx::countDown);
        fx.await();
        // replay stages are opened and closed per scenario - closing the last one must not stop FX
        Platform.setImplicitExit(false);

        scenario("io_register_buffer", SchematicGolden::buildIo);
        scenario("logic_gates", SchematicGolden::buildLogic);
        scenario("logic_truth", SchematicGolden::buildTruth);
        scenario("junction_fanout", SchematicGolden::buildFanout);
        scenario("decoder_encoder", SchematicGolden::buildDecoder);
        scenario("ram_bus", SchematicGolden::buildRam);
        scenario("keyboard_7seg_button", SchematicGolden::buildKeyboard);
        scenario("wire_edits", SchematicGolden::buildWireEdits);
        System.exit(0);
    }

    // ================================================================== infrastructure

    interface Builder {
        List<Map<String, Object>> build(SchematicSheet sheet) throws Exception;
    }

    private static <T> T fx(Callable<T> c) throws Exception {
        if (Platform.isFxApplicationThread()) return c.call();
        AtomicReference<T> result = new AtomicReference<>();
        AtomicReference<Exception> error = new AtomicReference<>();
        CountDownLatch l = new CountDownLatch(1);
        Platform.runLater(() -> {
            try {
                result.set(c.call());
            } catch (Exception e) {
                error.set(e);
            } finally {
                l.countDown();
            }
        });
        l.await();
        if (error.get() != null) throw error.get();
        return result.get();
    }

    private static void fxRun(Runnable r) throws Exception {
        fx(() -> {
            r.run();
            return null;
        });
    }

    private static void scenario(String name, Builder builder) throws Exception {
        Bus bus = Bus.getBus();
        Field rand = Bus.class.getDeclaredField("rand");
        rand.setAccessible(true);
        rand.set(bus, new Random(SEED));
        bus.reset();

        SchematicSheet sheet = fx(() -> new SchematicSheet(5000, 5000, GRID));
        List<Map<String, Object>> steps = fx(() -> builder.build(sheet));

        // save, then round-trip (load into a fresh sheet and save again)
        File schx = new File(out, name + ".schx");
        fx(() -> SchemeLoader.save(schx, sheet));
        SchematicSheet reloaded = fx(() -> new SchematicSheet(5000, 5000, GRID));
        boolean loaded = fx(() -> SchemeLoader.load(schx, reloaded));
        File roundTrip = new File(out, name + ".roundtrip.schx");
        fx(() -> SchemeLoader.save(roundTrip, reloaded));

        // the replay sheet is shown: JavaFX notifies node transform changes (which wire ends follow
        // when a component moves) only after a rendering pulse has synced the node - off-screen,
        // a gate moved once (by the loader) would never notify again
        javafx.stage.Stage stage = fx(() -> {
            javafx.stage.Stage st = new javafx.stage.Stage();
            st.setScene(new javafx.scene.Scene(reloaded, 1000, 800));
            st.show();
            return st;
        });
        Thread.sleep(300);

        // replay on the RELOADED sheet - the web port loads the same file, so both sides simulate
        // the structure the original loader produces (which differs from the built one for branches)
        // Math.random() drives floating inputs and short circuits - seed it so the web port can
        // reproduce the exact same draws with its bit-exact java.util.Random port
        Class<?> holder = Class.forName("java.lang.Math$RandomNumberGeneratorHolder");
        Field generator = holder.getDeclaredField("randomNumberGenerator");
        generator.setAccessible(true);
        ((Random) generator.get(null)).setSeed(MATH_RANDOM_SEED);

        List<Object> snapshots = new ArrayList<>();
        for (Map<String, Object> step : steps) {
            if (EDIT_OPS.contains((String) step.get("op"))) Thread.sleep(60); // let a pulse sync the nodes
            Object result = apply(reloaded, step);
            settle();
            fx(() -> null); // drain runLater work posted by the step (junction reconcile, settles)
            Map<String, Object> snap = fx(() -> snapshot(reloaded));
            if (EDIT_OPS.contains((String) step.get("op"))) snap.put("schx", saveToString(reloaded));
            Field seedField = Random.class.getDeclaredField("seed");
            seedField.setAccessible(true);
            snap.put("rngState", String.valueOf(((java.util.concurrent.atomic.AtomicLong) seedField.get(generator.get(null))).get()));
            if (result != null) snap.put("result", result);
            snapshots.add(snap);
        }
        fxRun(reloaded::powerOff);
        Thread.sleep(50);
        fxRun(stage::close);

        Map<String, Object> fixture = new LinkedHashMap<>();
        fixture.put("seed", SEED);
        fixture.put("mathRandomSeed", MATH_RANDOM_SEED);
        fixture.put("loaded", loaded);
        fixture.put("steps", steps);
        fixture.put("snapshots", snapshots);
        Files.write(new File(out, name + ".json").toPath(), Json.write(fixture).getBytes(StandardCharsets.UTF_8));
        System.out.println("recorded " + name);
    }

    private static String saveToString(SchematicSheet sheet) throws Exception {
        File tmp = File.createTempFile("golden", ".schx");
        try {
            fx(() -> SchemeLoader.save(tmp, sheet));
            return new String(Files.readAllBytes(tmp.toPath()), StandardCharsets.UTF_8);
        } finally {
            tmp.delete();
        }
    }

    private static void settle() throws Exception {
        Bus.getBus().waitForSteadyState();
    }

    private static Object apply(SchematicSheet sheet, Map<String, Object> step) throws Exception {
        String op = (String) step.get("op");
        Bus bus = Bus.getBus();
        switch (op) {
            case "power":
                fxRun(sheet::powerOn);
                // Service starts asynchronously - wait until the simulation thread runs
                long until = System.currentTimeMillis() + 5000;
                while (!sheet.isSimulationRunning() && System.currentTimeMillis() < until) Thread.sleep(1);
                Thread.sleep(20);
                return null;
            case "setOn": {
                Input in = (Input) gate(sheet, step);
                boolean v = (Boolean) step.get("value");
                fxRun(() -> in.setOn(v));
                return null;
            }
            case "button": {
                PushButton b = (PushButton) gate(sheet, step);
                boolean v = (Boolean) step.get("value");
                fxRun(() -> b.setPressedState(v));
                return null;
            }
            case "press": {
                MatrixKeyboard k = (MatrixKeyboard) gate(sheet, step);
                int r = (Integer) step.get("row"), c = (Integer) step.get("col");
                fxRun(() -> k.setPressed(r, c));
                return null;
            }
            case "release": {
                MatrixKeyboard k = (MatrixKeyboard) gate(sheet, step);
                int r = (Integer) step.get("row"), c = (Integer) step.get("col");
                fxRun(() -> k.releasePressed(r, c));
                return null;
            }
            case "address":
                bus.setAddressBus((short) (int) (Integer) step.get("addr"));
                return null;
            case "cpuWrite": {
                boolean io = (Boolean) step.get("io");
                bus.setAddressBus((short) (int) (Integer) step.get("addr"));
                bus.setDataBus((byte) (int) (Integer) step.get("data"));
                if (io) bus.setIW_(false); else bus.setMW_(false);
                settle();
                if (io) bus.setIW_(true); else bus.setMW_(true);
                settle();
                bus.setRandomData();
                bus.setRandomAddress();
                return null;
            }
            case "cpuRead": {
                boolean io = (Boolean) step.get("io");
                bus.setAddressBus((short) (int) (Integer) step.get("addr"));
                if (io) bus.setIR_(false); else bus.setMR_(false);
                settle();
                int data = Byte.toUnsignedInt(bus.getDataBus());
                if (io) bus.setIR_(true); else bus.setMR_(true);
                bus.setRandomData();
                bus.setRandomAddress();
                return data;
            }
            case "wait":
                Thread.sleep((Integer) step.get("ms"));
                return null;
            case "wire": {
                Pin a = pinOf(sheet, step.get("from"));
                Pin b = pinOf(sheet, step.get("to"));
                fxRun(() -> wire(sheet, a, b));
                return null;
            }
            case "branch": {
                Pin from = pinOf(sheet, step.get("from"));
                Pin to = pinOf(sheet, step.get("to"));
                fxRun(() -> branch(sheet, from.getWireEnd().getWire(), to));
                return null;
            }
            case "drag": {
                GateSymbol g = gate(sheet, step);
                int gx = (Integer) step.get("gx"), gy = (Integer) step.get("gy");
                fxRun(() -> {
                    setComponentDragging(true);
                    g.moveTo(gx, gy);
                    // what the pin-position listener does in the running app; off-screen JavaFX does
                    // not reliably notify localToParentTransform changes (no-op if it already fired)
                    for (Pin p : g.getPins()) {
                        if (p.getWireEnd() != null) p.getWireEnd().refreshPosition();
                    }
                });
                return null;
            }
            case "dragRelease": {
                GateSymbol g = gate(sheet, step);
                fxRun(() -> {
                    // Movable.finishComponentDrag + GateSymbol.snapPinsToFreeEnds
                    setComponentDragging(false);
                    for (javafx.scene.Node node : new ArrayList<>(sheet.getJunctionsLayer().getChildren())) {
                        if (node instanceof WireJunction) WireJunction.markDirty((WireJunction) node);
                    }
                    WireJunction.processNow();
                    Wire.connectFreeEndsToPins(sheet, g.getPins());
                });
                return null;
            }
            case "deleteWire": {
                Pin at = pinOf(sheet, step.get("at"));
                fxRun(() -> at.getWireEnd().getWire().delete());
                return null;
            }
            default:
                throw new IllegalArgumentException(op);
        }
    }

    private static void setComponentDragging(boolean value) {
        try {
            Field f = Movable.class.getDeclaredField("componentDragging");
            f.setAccessible(true);
            f.set(null, value);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Pin pinOf(SchematicSheet sheet, Object ref) {
        List<Object> r = (List<Object>) ref;
        String id = (String) r.get(0);
        for (GateSymbol g : sheet.getGates()) if (id.equals(g.getId())) return g.getPins().get((Integer) r.get(1));
        throw new IllegalArgumentException("no gate " + id);
    }

    private static List<Object> ref(GateSymbol g, int pin) {
        return Arrays.asList(g.getId(), pin);
    }

    private static GateSymbol gate(SchematicSheet sheet, Map<String, Object> step) {
        String id = (String) step.get("gate");
        for (GateSymbol g : sheet.getGates()) if (id.equals(g.getId())) return g;
        throw new IllegalArgumentException("no gate " + id);
    }

    private static Map<String, Object> snapshot(SchematicSheet sheet) throws Exception {
        Map<String, Object> s = new LinkedHashMap<>();
        Bus bus = Bus.getBus();
        s.put("address", Short.toUnsignedInt(bus.getAddressBus()));
        s.put("data", Byte.toUnsignedInt(bus.getDataBus()));
        s.put("control", bus.getControlBus());
        List<Object> gates = new ArrayList<>();
        IdentityHashMap<Object, Integer> nets = new IdentityHashMap<>();
        for (GateSymbol g : sheet.getGates()) {
            Map<String, Object> gm = new LinkedHashMap<>();
            gm.put("id", g.getId());
            List<Object> pins = new ArrayList<>();
            for (Pin p : g.getPins()) {
                String value = p.getPotential() == null ? "null" : String.valueOf(p.getPotential().getValue());
                Object root = p.getPotential();
                if (!nets.containsKey(root)) nets.put(root, nets.size());
                pins.add(Arrays.asList(p.getName(), value, nets.get(root)));
            }
            gm.put("pins", pins);
            if (g instanceof Led) gm.put("lit", ((Led) g).isLit());
            if (g instanceof Register8) gm.put("latch", ((Register8) g).getLatch());
            if (g instanceof SevenSegmentDisplay) {
                Field lit = SevenSegmentDisplay.class.getDeclaredField("litSegments");
                lit.setAccessible(true);
                List<Object> segs = new ArrayList<>();
                for (boolean b : (boolean[]) lit.get(g)) segs.add(b);
                gm.put("segments", segs);
                Field powered = SevenSegmentDisplay.class.getDeclaredField("powered");
                powered.setAccessible(true);
                gm.put("powered", powered.get(g));
            }
            gates.add(gm);
        }
        s.put("gates", gates);
        return s;
    }

    // ================================================================== construction helpers

    /** Places a gate; x/y are in 20 px component cells (2 grid units each on the 10 px grid). */
    private static <T extends GateSymbol> T place(SchematicSheet sheet, T gate, int x, int y) {
        sheet.addItem(gate);
        gate.moveTo(2 * x, 2 * y);
        sheet.getOccupancy().occupy(gate);
        return gate;
    }

    /** A straight pin-to-pin wire as an old file loads it (no settle - it may be diagonal). */
    private static Wire wireRaw(SchematicSheet sheet, Pin a, Pin b) {
        Wire w = new Wire(sheet);
        sheet.addItem(w);
        w.getEnds()[0].connect(a);
        w.getEnds()[1].connect(b);
        return w;
    }

    /** A wire between two pins, settled like a finished drag (an L bend becomes two wires). */
    private static Wire wire(SchematicSheet sheet, Pin a, Pin b) {
        Wire w = new Wire(sheet);
        sheet.addItem(w);
        w.getEnds()[0].connect(a);
        w.getEnds()[1].connect(b);
        w.settleToGrid();
        return w;
    }

    /**
     * Branch from the chain of `trunk` (the wires joined through invisible bends): its longest wire
     * is split at the middle and a new wire runs from the junction to `to`.
     */
    private static Wire branch(SchematicSheet sheet, Wire trunk, Pin to) {
        List<Wire> chain = new ArrayList<>();
        LinkedList<Wire> queue = new LinkedList<>();
        chain.add(trunk);
        queue.add(trunk);
        while (!queue.isEmpty()) {
            Wire current = queue.poll();
            for (sk.uniza.fri.cp.SchematicSim.Wire.WireEnd end : current.getEnds()) {
                WireJunction j = end.getJunction();
                if (j == null || j.getConnectedWires().size() != 2) continue;
                for (Wire n : j.getConnectedWires()) {
                    if (!chain.contains(n)) {
                        chain.add(n);
                        queue.add(n);
                    }
                }
            }
        }
        Wire best = null;
        double bestLen = -1;
        for (Wire w : chain) {
            double len = w.getEnds()[0].getConnectionPoint().distance(w.getEnds()[1].getConnectionPoint());
            if (len > bestLen) {
                bestLen = len;
                best = w;
            }
        }
        Point2D p0 = best.getEnds()[0].getConnectionPoint();
        Point2D p1 = best.getEnds()[1].getConnectionPoint();
        WireJunction j = best.splitAtPoint(p0.midpoint(p1));
        if (j == null) throw new IllegalStateException("split failed");
        Wire w = new Wire(sheet);
        sheet.addItem(w);
        w.getEnds()[0].connect(j);
        w.getEnds()[1].connect(to);
        w.settleToGrid();
        return w;
    }

    private static Map<String, Object> step(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    // ================================================================== scenarios

    /** CPU OUT → register → LEDs; switches → bus buffers → CPU IN (unsettled pin-to-pin wires). */
    private static List<Map<String, Object>> buildIo(SchematicSheet sheet) {
        ControlBus cb = place(sheet, new ControlBus(sheet), 2, 2);
        Pin iw = cb.createTap(2, 20);
        List<Pin> ir = new ArrayList<>();
        cb.setRows(12);
        for (int i = 0; i < 8; i++) ir.add(cb.createTap(3, 40 + i * 20));

        DataBus8 db = place(sheet, new DataBus8(sheet), 2, 16);
        db.setRows(18);
        List<Pin> dOut = new ArrayList<>(), dIn = new ArrayList<>();
        for (int i = 0; i < 8; i++) dOut.add(db.createTap(i, 20 + i * 20));
        for (int i = 0; i < 8; i++) dIn.add(db.createTap(i, 180 + i * 20));

        NotGate not = place(sheet, new NotGate(sheet), 8, 2);
        Input low = place(sheet, new Input(sheet), 8, 6);
        Register8 reg = place(sheet, new Register8(sheet), 12, 16);
        wireRaw(sheet, iw, not.getPins().get(0));
        wireRaw(sheet, not.getPins().get(1), reg.getPins().get(9));  // LE
        wireRaw(sheet, low.getPins().get(0), reg.getPins().get(8));  // OE_
        for (int i = 0; i < 8; i++) {
            wireRaw(sheet, dOut.get(i), reg.getPins().get(i));
            Led led = place(sheet, new Led(sheet), 20, 14 + 3 * i);
            wireRaw(sheet, reg.getPins().get(10 + i), led.getPins().get(0));
        }
        List<String> switches = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            BusBuffer buf = place(sheet, new BusBuffer(sheet), 30, 34 + 3 * i);
            Input sw = place(sheet, new Input(sheet), 36, 34 + 3 * i);
            sw.placeOutput(sk.uniza.fri.cp.SchematicSim.Side.LEFT);
            wireRaw(sheet, sw.getPins().get(0), buf.getPins().get(0));
            wireRaw(sheet, ir.get(i), buf.getPins().get(1));
            wireRaw(sheet, buf.getPins().get(2), dIn.get(i));
            switches.add(sw.getId());
        }

        List<Map<String, Object>> steps = new ArrayList<>();
        steps.add(step("op", "power"));
        steps.add(step("op", "cpuWrite", "io", true, "addr", 255, "data", 0xA5));
        steps.add(step("op", "cpuWrite", "io", true, "addr", 255, "data", 0x3C));
        steps.add(step("op", "cpuRead", "io", true, "addr", 255));
        steps.add(step("op", "setOn", "gate", switches.get(0), "value", true));
        steps.add(step("op", "setOn", "gate", switches.get(2), "value", true));
        steps.add(step("op", "setOn", "gate", switches.get(7), "value", true));
        steps.add(step("op", "cpuRead", "io", true, "addr", 255));
        steps.add(step("op", "wait", "ms", 150));
        steps.add(step("op", "cpuWrite", "io", true, "addr", 255, "data", 0x00));
        steps.add(step("op", "wait", "ms", 150));
        return steps;
    }

    /**
     * Three switches fanned out through junctions to AND/OR/NAND/NOR/XOR (3 inputs) and NOT. Each
     * input has its own vertical trunk (the wire is drawn from the gate pin to the switch, so the
     * bend's vertical arm runs at the switch's x); the other gates tap the trunk with straight
     * horizontal branches. LEDs sit on their gate's output row (straight wires). No two nets share
     * a point, so the loader's position-keyed junction sharing cannot short them.
     */
    private static List<Map<String, Object>> buildLogic(SchematicSheet sheet) {
        Input a = placeGrid(sheet, new Input(sheet), 4, 90);
        Input b = placeGrid(sheet, new Input(sheet), 12, 90);
        Input c = placeGrid(sheet, new Input(sheet), 20, 90);
        MultiInputGate[] gates = {
                placeGrid(sheet, new AndGate(sheet), 40, 4), placeGrid(sheet, new OrGate(sheet), 40, 16),
                placeGrid(sheet, new NandGate(sheet), 40, 28), placeGrid(sheet, new NorGate(sheet), 40, 40),
                placeGrid(sheet, new XorGate(sheet), 40, 52)};
        for (MultiInputGate g : gates) {
            g.setInputCount(3);
            sheet.getOccupancy().free(g);
            sheet.getOccupancy().occupy(g);
        }
        NotGate not = placeGrid(sheet, new NotGate(sheet), 40, 64);
        Input[] in = {a, b, c};
        for (int k = 0; k < 3; k++) {
            // trunk: gate pin first, so the corner lies at (switch x, pin y) - vertical arm at the switch
            Wire trunk = wire(sheet, gates[0].getPins().get(k), in[k].getPins().get(0));
            for (int g = 1; g < gates.length; g++) tap(sheet, in[k], gates[g].getPins().get(k));
            if (k == 0) tap(sheet, in[k], not.getPins().get(0));
        }
        for (GateSymbol g : new GateSymbol[]{gates[0], gates[1], gates[2], gates[3], gates[4], not}) {
            Pin outPin = g.getPins().get(g.getPins().size() - 1);
            Point2D p = outPin.getSceneGridPosition();
            // LED input pin is one component cell (20 px) below its origin
            Led led = placeGrid(sheet, new Led(sheet), 60, (int) Math.round((p.getY() - 20) / GRID));
            wire(sheet, outPin, led.getPins().get(0));
        }

        List<Map<String, Object>> steps = new ArrayList<>();
        steps.add(step("op", "power"));
        String[] ids = {a.getId(), b.getId(), c.getId()};
        for (int combo = 1; combo < 8; combo++) {
            int prev = combo - 1;
            for (int k = 0; k < 3; k++) {
                boolean want = (combo & (1 << k)) != 0;
                if (want != ((prev & (1 << k)) != 0)) steps.add(step("op", "setOn", "gate", ids[k], "value", want));
            }
        }
        steps.add(step("op", "setOn", "gate", ids[0], "value", false));
        steps.add(step("op", "wait", "ms", 150));
        return steps;
    }

    /** Places a gate at raw grid coordinates (10 px units). */
    private static <T extends GateSymbol> T placeGrid(SchematicSheet sheet, T gate, int gx, int gy) {
        sheet.addItem(gate);
        gate.moveTo(gx, gy);
        sheet.getOccupancy().occupy(gate);
        return gate;
    }

    /**
     * Branch from the vertical trunk of `source`'s net at the target pin's row: the trunk wire
     * crossing that row is split there and a straight wire runs to the pin.
     */
    private static Wire tap(SchematicSheet sheet, Input source, Pin to) {
        Point2D target = to.getSceneGridPosition();
        double x = source.getPins().get(0).getSceneGridPosition().getX();
        Point2D at = new Point2D(x, target.getY());
        Wire host = null;
        for (Wire w : sheet.getWires()) {
            // the trunk's vertical arm: both ends at the switch's x (unique per net)
            if (w.distanceToPoint(at) < 0.5
                    && Math.abs(w.getEnds()[0].getConnectionPoint().getX() - x) < 0.5
                    && Math.abs(w.getEnds()[1].getConnectionPoint().getX() - x) < 0.5) {
                host = w;
                break;
            }
        }
        if (host == null) throw new IllegalStateException("no trunk at " + at);
        WireJunction j = host.splitAtPoint(at);
        if (j == null) throw new IllegalStateException("split failed at " + at);
        Wire w = new Wire(sheet);
        sheet.addItem(w);
        w.getEnds()[0].connect(j);
        w.getEnds()[1].connect(to);
        w.settleToGrid();
        return w;
    }

    /** Truth tables without branches: every gate input has its own switch. */
    private static List<Map<String, Object>> buildTruth(SchematicSheet sheet) {
        Class<?>[] kinds = {AndGate.class, OrGate.class, NandGate.class, NorGate.class, XorGate.class};
        List<List<String>> sw = new ArrayList<>();
        int y = 2;
        for (Class<?> kind : kinds) {
            MultiInputGate g;
            try {
                g = (MultiInputGate) kind.getConstructor(SchematicSheet.class).newInstance(sheet);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
            place(sheet, g, 10, y);
            List<String> ids = new ArrayList<>();
            for (int k = 0; k < 2; k++) {
                Input in = place(sheet, new Input(sheet), 2, y + 3 * k);
                wire(sheet, in.getPins().get(0), g.getPins().get(k));
                ids.add(in.getId());
            }
            Led led = place(sheet, new Led(sheet), 16, y);
            wire(sheet, g.getPins().get(2), led.getPins().get(0));
            sw.add(ids);
            y += 7;
        }
        NotGate not = place(sheet, new NotGate(sheet), 10, y);
        Input nin = place(sheet, new Input(sheet), 2, y);
        Led nled = place(sheet, new Led(sheet), 16, y);
        wire(sheet, nin.getPins().get(0), not.getPins().get(0));
        wire(sheet, not.getPins().get(1), nled.getPins().get(0));

        List<Map<String, Object>> steps = new ArrayList<>();
        steps.add(step("op", "power"));
        steps.add(step("op", "wait", "ms", 150));
        int[][] seq = {{0, 1}, {1, 1}, {0, 0}, {1, 0}};
        for (int[] s2 : seq) {
            for (List<String> ids : sw) steps.add(step("op", "setOn", "gate", ids.get(s2[0]), "value", s2[1] == 1));
            steps.add(step("op", "wait", "ms", 150));
        }
        steps.add(step("op", "setOn", "gate", nin.getId(), "value", true));
        steps.add(step("op", "wait", "ms", 150));
        return steps;
    }

    /** One switch fanned out to three LEDs through junction branches on a long trunk. */
    private static List<Map<String, Object>> buildFanout(SchematicSheet sheet) {
        Input in = place(sheet, new Input(sheet), 2, 2);
        Led l1 = place(sheet, new Led(sheet), 40, 2);
        Led l2 = place(sheet, new Led(sheet), 20, 12);
        Led l3 = place(sheet, new Led(sheet), 30, 20);
        l2.placeInput(sk.uniza.fri.cp.SchematicSim.Side.TOP);
        l3.placeInput(sk.uniza.fri.cp.SchematicSim.Side.TOP);
        Wire trunk = wire(sheet, in.getPins().get(0), l1.getPins().get(0));
        Wire rest = branch(sheet, trunk, l2.getPins().get(0));
        branch(sheet, trunk, l3.getPins().get(0));
        List<Map<String, Object>> steps = new ArrayList<>();
        steps.add(step("op", "power"));
        steps.add(step("op", "setOn", "gate", in.getId(), "value", true));
        steps.add(step("op", "setOn", "gate", in.getId(), "value", false));
        steps.add(step("op", "wait", "ms", 150));
        return steps;
    }

    /** Address bus → 3→8 decoder → 8→3 priority encoder → LEDs. */
    private static List<Map<String, Object>> buildDecoder(SchematicSheet sheet) {
        AddressBus16 ab = place(sheet, new AddressBus16(sheet), 2, 2);
        Pin[] a = {ab.createTap(0, 20), ab.createTap(1, 40), ab.createTap(2, 60)};
        Decoder38 dek = place(sheet, new Decoder38(sheet), 10, 2);
        Encoder83 kod = place(sheet, new Encoder83(sheet), 22, 2);
        Input g = place(sheet, new Input(sheet), 4, 16);
        Input ei = place(sheet, new Input(sheet), 16, 16);
        for (int i = 0; i < 3; i++) wire(sheet, a[i], dek.getPins().get(i));
        wire(sheet, g.getPins().get(0), dek.getPins().get(3));
        for (int i = 0; i < 8; i++) wire(sheet, dek.getPins().get(4 + i), kod.getPins().get(1 + i));
        wire(sheet, ei.getPins().get(0), kod.getPins().get(0));
        for (int i = 0; i < 5; i++) {
            Led led = place(sheet, new Led(sheet), 30, 2 + 3 * i);
            wire(sheet, kod.getPins().get(9 + i), led.getPins().get(0));
        }
        List<Map<String, Object>> steps = new ArrayList<>();
        steps.add(step("op", "power"));
        steps.add(step("op", "address", "addr", 0));
        steps.add(step("op", "setOn", "gate", g.getId(), "value", true));
        for (int k = 1; k < 8; k++) steps.add(step("op", "address", "addr", k));
        steps.add(step("op", "setOn", "gate", ei.getId(), "value", true));
        steps.add(step("op", "setOn", "gate", ei.getId(), "value", false));
        steps.add(step("op", "setOn", "gate", g.getId(), "value", false));
        return steps;
    }

    /** RAM 8k on the address/data/control buses, written and read by CPU memory cycles. */
    private static List<Map<String, Object>> buildRam(SchematicSheet sheet) {
        AddressBus16 ab = place(sheet, new AddressBus16(sheet), 2, 2);
        ab.setRows(15);
        DataBus8 db = place(sheet, new DataBus8(sheet), 6, 2);
        ControlBus cb = place(sheet, new ControlBus(sheet), 10, 2);
        Ram8k ram = place(sheet, new Ram8k(sheet), 16, 2);
        Input e1 = place(sheet, new Input(sheet), 26, 2);
        Input e2 = place(sheet, new Input(sheet), 26, 6);
        for (int i = 0; i < 13; i++) wire(sheet, ab.createTap(i, 20 + i * 20), ram.getPins().get(12 + i));
        for (int i = 0; i < 8; i++) wire(sheet, db.createTap(i, 20 + i * 20), ram.getPins().get(i));
        wire(sheet, cb.createTap(0, 20), ram.getPins().get(8));  // MW_ -> WE_
        wire(sheet, cb.createTap(1, 40), ram.getPins().get(9));  // MR_ -> OE_
        wire(sheet, e1.getPins().get(0), ram.getPins().get(10)); // E1_ (off = 0 = enabled)
        wire(sheet, e2.getPins().get(0), ram.getPins().get(11)); // E2
        List<Map<String, Object>> steps = new ArrayList<>();
        steps.add(step("op", "setOn", "gate", e2.getId(), "value", true));
        steps.add(step("op", "power"));
        steps.add(step("op", "cpuWrite", "io", false, "addr", 0x0012, "data", 0x5A));
        steps.add(step("op", "cpuWrite", "io", false, "addr", 0x1FFF, "data", 0xC3));
        steps.add(step("op", "cpuRead", "io", false, "addr", 0x0012));
        steps.add(step("op", "cpuRead", "io", false, "addr", 0x1FFF));
        steps.add(step("op", "cpuRead", "io", false, "addr", 0x0000));
        steps.add(step("op", "setOn", "gate", e2.getId(), "value", false));
        steps.add(step("op", "cpuRead", "io", false, "addr", 0x0012));
        return steps;
    }

    /**
     * Wire editing on the loaded sheet: branch from a wire, new wire, component drag + release
     * (the wires follow, bends split / merge), wire delete; then a power-on check of the nets.
     */
    private static List<Map<String, Object>> buildWireEdits(SchematicSheet sheet) {
        Input a = place(sheet, new Input(sheet), 2, 2);
        Input b = place(sheet, new Input(sheet), 2, 8);
        AndGate and = place(sheet, new AndGate(sheet), 12, 3);
        NotGate not = place(sheet, new NotGate(sheet), 12, 12);
        Led l1 = place(sheet, new Led(sheet), 22, 4);
        Led l2 = place(sheet, new Led(sheet), 22, 13);
        wire(sheet, a.getPins().get(0), and.getPins().get(0));
        wire(sheet, b.getPins().get(0), and.getPins().get(1));
        wire(sheet, and.getPins().get(2), l1.getPins().get(0));

        List<Map<String, Object>> steps = new ArrayList<>();
        steps.add(step("op", "branch", "from", ref(a, 0), "to", ref(not, 0)));
        steps.add(step("op", "wire", "from", ref(not, 1), "to", ref(l2, 0)));
        steps.add(step("op", "drag", "gate", and.getId(), "gx", 24, "gy", 10));
        steps.add(step("op", "dragRelease", "gate", and.getId()));
        steps.add(step("op", "drag", "gate", not.getId(), "gx", 24, "gy", 26));
        steps.add(step("op", "dragRelease", "gate", not.getId()));
        steps.add(step("op", "deleteWire", "at", ref(b, 0)));
        steps.add(step("op", "wire", "from", ref(b, 0), "to", ref(and, 1)));
        steps.add(step("op", "power"));
        steps.add(step("op", "setOn", "gate", a.getId(), "value", true));
        steps.add(step("op", "setOn", "gate", b.getId(), "value", true));
        steps.add(step("op", "wait", "ms", 150));
        steps.add(step("op", "setOn", "gate", a.getId(), "value", false));
        steps.add(step("op", "wait", "ms", 150));
        return steps;
    }

    /** Matrix keyboard, push button and 7-segment display (incl. CA hold). */
    private static List<Map<String, Object>> buildKeyboard(SchematicSheet sheet) {
        MatrixKeyboard kbd = place(sheet, new MatrixKeyboard(sheet), 10, 10);
        List<String> rows = new ArrayList<>();
        for (int r = 0; r < 4; r++) {
            Input in = place(sheet, new Input(sheet), 2, 8 + 4 * r);
            wire(sheet, in.getPins().get(0), kbd.getPins().get(r));
            rows.add(in.getId());
        }
        for (int c = 0; c < 4; c++) {
            Led led = place(sheet, new Led(sheet), 11 + 2 * c, 2);
            led.placeInput(sk.uniza.fri.cp.SchematicSim.Side.BOTTOM);
            wire(sheet, kbd.getPins().get(4 + c), led.getPins().get(0));
        }
        PushButton btn = place(sheet, new PushButton(sheet), 24, 12);
        Input btnIn = place(sheet, new Input(sheet), 20, 12);
        Led btnLed = place(sheet, new Led(sheet), 24, 6);
        btnLed.placeInput(sk.uniza.fri.cp.SchematicSim.Side.BOTTOM);
        wire(sheet, btnIn.getPins().get(0), btn.getPins().get(0));
        wire(sheet, btn.getPins().get(1), btnLed.getPins().get(0));

        SevenSegmentDisplay seg = place(sheet, new SevenSegmentDisplay(sheet), 34, 2);
        Input sa = place(sheet, new Input(sheet), 28, 2);
        Input sb = place(sheet, new Input(sheet), 28, 5);
        Input ca = place(sheet, new Input(sheet), 28, 9);
        wire(sheet, sa.getPins().get(0), seg.getPins().get(0));
        wire(sheet, sb.getPins().get(0), seg.getPins().get(1));
        wire(sheet, ca.getPins().get(0), seg.getPins().get(8));

        List<Map<String, Object>> steps = new ArrayList<>();
        for (int r = 1; r < 4; r++) steps.add(step("op", "setOn", "gate", rows.get(r), "value", true));
        steps.add(step("op", "setOn", "gate", sb.getId(), "value", true));
        steps.add(step("op", "power"));
        steps.add(step("op", "press", "gate", kbd.getId(), "row", 0, "col", 2));
        steps.add(step("op", "release", "gate", kbd.getId(), "row", 0, "col", 2));
        steps.add(step("op", "press", "gate", kbd.getId(), "row", 1, "col", 1));
        steps.add(step("op", "release", "gate", kbd.getId(), "row", 1, "col", 1));
        steps.add(step("op", "button", "gate", btn.getId(), "value", true));
        steps.add(step("op", "button", "gate", btn.getId(), "value", false));
        steps.add(step("op", "setOn", "gate", ca.getId(), "value", true));
        steps.add(step("op", "wait", "ms", 150));
        steps.add(step("op", "setOn", "gate", ca.getId(), "value", false));
        steps.add(step("op", "setOn", "gate", sa.getId(), "value", true));
        steps.add(step("op", "wait", "ms", 150));
        return steps;
    }
}
