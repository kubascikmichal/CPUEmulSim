package sk.uniza.fri.cp.SchematicSim.Gates;

import javafx.application.Platform;
import javafx.beans.binding.Bindings;
import javafx.scene.control.ContextMenu;
import javafx.scene.control.Menu;
import javafx.scene.control.RadioMenuItem;
import javafx.scene.control.SeparatorMenuItem;
import javafx.scene.control.ToggleGroup;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import javafx.scene.input.MouseButton;
import javafx.scene.layout.Pane;
import javafx.scene.paint.Color;
import javafx.scene.shape.Circle;
import javafx.scene.text.Text;
import sk.uniza.fri.cp.SchematicSim.Pin.InputPin;
import sk.uniza.fri.cp.SchematicSim.Pin.Pin;
import sk.uniza.fri.cp.SchematicSim.Sheet.SchematicSheet;
import sk.uniza.fri.cp.SchematicSim.Side;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Samostatná LED dióda - obyčajný farebný kruh s jedným prípojným bodom {@code IN}.
 * Dióda svieti, keď je na vstupe logická 1 (HIGH), inak je zhasnutá. Je čisto pasívna -
 * nemá žiadne výstupné vývody, nikdy nehynie na zbernicu, a preto nemôže spôsobiť skrat.
 * Pravým tlačidlom myši sa otvorí kontextové menu s výberom umiestnenia vývodu
 * (vpravo/vľavo/hore/dole) a farby LED. Štandardne je vývod vľavo a farba červená.
 *
 * @author Claude (návrh podľa SchematicSim architektúry)
 */
public class Led extends GateSymbol {

    private static final int GRID_WIDTH = 2;
    private static final int GRID_HEIGHT = 2;
    private static final long INPUT_HOLD_MS = 100L;

    private static final Color LED_OFF = Color.DARKGRAY;

    private static final Map<String, Color> LED_COLORS = new LinkedHashMap<>();
    static {
        LED_COLORS.put("Červená", Color.RED);
        LED_COLORS.put("Zelená", Color.GREEN);
        LED_COLORS.put("Modrá", Color.BLUE);
        LED_COLORS.put("Žltá", Color.YELLOW);
        LED_COLORS.put("Oranžová", Color.ORANGE);
    }

    private Pin pinIn;
    private Circle light;
    private ContextMenu contextMenu;
    private ToggleGroup colorGroup;
    private ToggleGroup placementGroup;

    private volatile boolean on = false;
    private boolean wasHigh = false;
    private long litSinceMs = 0L;
    private volatile Color ledColor = LED_COLORS.get("Červená");

    /** Konštruktor pre paletku (ItemPicker). */
    public Led() {
        super();
    }

    @Override
    public Pane getImage() {
        Text label = new Text(getName());
        label.setLayoutY(label.getBoundsInLocal().getHeight());

        Image image = new Image(getClass().getResourceAsStream("/icons/led.png"));
        ImageView view = new ImageView(image);
        view.setLayoutY(label.getBoundsInLocal().getHeight() + 5);

        label.layoutXProperty().bind(Bindings.createDoubleBinding(
                () -> (image.getWidth() - label.getBoundsInLocal().getWidth()) / 2.0,
                image.widthProperty(), label.boundsInLocalProperty()));

        return new Pane(label, view);
    }

    /** Konštruktor pre umiestnenie na plochu - volaný reflexiou zo SchematicSheet. */
    public Led(SchematicSheet sheet) {
        super(sheet);
    }

    @Override
    protected List<Pin> createPins() {
        pinIn = new InputPin(this, "IN", 0, 1, Side.LEFT);
        return Arrays.asList(pinIn);
    }

    @Override
    protected Pane drawBody() {
        int cell = getSheet().getComponentCell();
        double w = getGridWidth() * cell;
        double h = getGridHeight() * cell;

        light = new Circle(w / 2.0, h / 2.0, cell * 0.55, LED_OFF);
        light.setStroke(Color.BLACK);
        light.setStrokeWidth(3);
        // menu sa otvára na pravom tlačidle myši; MOUSE_PRESSED je spoľahlivejší ako
        // CONTEXT_MENU_REQUESTED (ten sa negeneruje, ak pravý stlač počas cesty niekto skonzumuje)
        light.setOnMousePressed(event -> {
            if (event.getButton() == MouseButton.SECONDARY) {
                if (getSheet() != null && getSheet().isEditingEnabled()) showMenu(event.getScreenX(), event.getScreenY());
                event.consume();
            }
        });
        light.setOnContextMenuRequested(event -> {
            if (getSheet() == null || !getSheet().isEditingEnabled()) return;
            if (contextMenu == null || !contextMenu.isShowing()) {
                showMenu(event.getScreenX(), event.getScreenY());
            }
            event.consume();
        });

        return new Pane(light);
    }

    private void showMenu(double screenX, double screenY) {
        if (contextMenu == null) {
            Menu placement = new Menu("Vývod");
            placementGroup = new ToggleGroup();
            placement.getItems().add(placementItem("vpravo", Side.RIGHT, placementGroup));
            placement.getItems().add(placementItem("vľavo", Side.LEFT, placementGroup));
            placement.getItems().add(placementItem("hore", Side.TOP, placementGroup));
            placement.getItems().add(placementItem("dole", Side.BOTTOM, placementGroup));

            Menu colorMenu = new Menu("Farba LED");
            colorGroup = new ToggleGroup();
            for (Map.Entry<String, Color> entry : LED_COLORS.entrySet()) {
                RadioMenuItem item = new RadioMenuItem(entry.getKey());
                item.setToggleGroup(colorGroup);
                item.setUserData(entry.getValue());
                item.setOnAction(e -> setColor((Color) item.getUserData()));
                colorMenu.getItems().add(item);
            }

            contextMenu = new ContextMenu(placement, new SeparatorMenuItem(), colorMenu);
        }
        //zaskrtnuta je skutocna farba a strana vyvodu LED (ziadna farba, ak nie je v zozname)
        selectByUserData(colorGroup, ledColor);
        selectByUserData(placementGroup, pinIn.getExitSide());
        contextMenu.show(light, screenX, screenY);
    }

    private static void selectByUserData(ToggleGroup group, Object value) {
        group.selectToggle(null);
        for (javafx.scene.control.Toggle toggle : group.getToggles()) {
            if (value.equals(toggle.getUserData())) {
                group.selectToggle(toggle);
                return;
            }
        }
    }

    private RadioMenuItem placementItem(String label, Side side, ToggleGroup group) {
        RadioMenuItem item = new RadioMenuItem(label);
        item.setToggleGroup(group);
        item.setUserData(side);
        item.setOnAction(e -> placeInput((Side) item.getUserData()));
        if (side == pinIn.getExitSide()) item.setSelected(true);
        return item;
    }

    public void placeInput(Side side) {
        int cell = getSheet().getComponentCell();
        pinIn.setLayoutX(placementOffsetX(side) * cell);
        pinIn.setLayoutY(placementOffsetY(side) * cell);
        pinIn.setSide(side);

        // ak na vývode už visí vodič, presuň jeho koniec na novú polohu a preveď rerouting
        if (pinIn.getWireEnd() != null) {
            pinIn.getWireEnd().refreshPosition();
        }
    }

    private static int placementOffsetX(Side side) {
        switch (side) {
            case LEFT: return 0;
            case RIGHT: return GRID_WIDTH;
            case TOP:
            case BOTTOM: return 1;
        }
        return 0;
    }

    private static int placementOffsetY(Side side) {
        switch (side) {
            case TOP: return 0;
            case BOTTOM: return GRID_HEIGHT;
            case LEFT:
            case RIGHT: return 1;
        }
        return 1;
    }

    @Override
    public void simulate() {
        long now = System.currentTimeMillis();
        boolean high = isHigh(pinIn);
        applyInputState(high, now);
    }

    /**
     * Stavový automat svietenia. LED svieti počas HIGH a ešte minimálne {@code INPUT_HOLD_MS}
     * od posledného prechodu LOW->HIGH. Ak už svieti aspoň 100 ms a vstup klesne na LOW,
     * zhasne okamžite; krátky impulz zaručí svietenie na 100 ms.
     */
    private void applyInputState(boolean high, long now) {
        if (high) {
            if (!wasHigh) {
                // LOW->HIGH: reštart počítania minimálnej doby svietenia
                wasHigh = true;
                litSinceMs = now;
            }
            setLitState(true);
            return;
        }

        if (wasHigh) wasHigh = false;

        if (on && now - litSinceMs < INPUT_HOLD_MS) {
            setLitState(true);
        } else {
            setLitState(false);
        }
    }

    private void setLitState(boolean lit) {
        if (lit != on) {
            on = lit;
            refreshVisual();
        }
    }

    @Override
    public void reset() {
        if (pinIn != null) setPinForce(pinIn, Pin.PinState.NOT_CONNECTED);
        wasHigh = false;
        litSinceMs = 0L;
        setLitState(false);
    }

    /**
     * Aktualizácia vizuálu vždy na FX vlákne (simulácia beží na separátnom vlákne).
     * Zmeny sú skoalescované do jednej čakajúcej úlohy, aby sa pri rýchlej simulácii
     * FX vlákno nezahltilo radom a aplikácia (klávesy F4/F5/F10...) ostala odozvá.
     */
    private volatile boolean visualUpdateScheduled;

    private void refreshVisual() {
        if (light == null || visualUpdateScheduled) return;
        visualUpdateScheduled = true;
        Platform.runLater(() -> {
            visualUpdateScheduled = false;
            light.setFill(on ? ledColor : LED_OFF);
        });
    }

    public boolean isLit() {
        return on;
    }

    public boolean isContextMenuShowing() {
        return contextMenu != null && contextMenu.isShowing();
    }

    public Color getLedColor() {
        return ledColor;
    }

    /**
     * Priame nastavenie farby LED (ekvivalent voľby v kontextovom menu).
     */
    public void setColor(Color color) {
        ledColor = color;
        refreshVisual();
    }

    @Override
    public Map<String, String> saveProperties() {
        Map<String, String> properties = new LinkedHashMap<>();
        properties.put("color", toHex(ledColor));
        properties.put("pinSide", pinIn.getExitSide().name());
        return properties;
    }

    @Override
    public void loadProperties(Map<String, String> properties) {
        String color = properties.get("color");
        if (color != null) {
            Color found = LED_COLORS.get(color);
            setColor(found != null ? found : Color.web(color));
        }

        String side = properties.get("pinSide");
        if (side != null) {
            try {
                placeInput(Side.valueOf(side));
            } catch (IllegalArgumentException ignored) {
            }
        }
    }

    private static String toHex(Color color) {
        return String.format("#%02X%02X%02X",
                (int) Math.round(color.getRed() * 255),
                (int) Math.round(color.getGreen() * 255),
                (int) Math.round(color.getBlue() * 255));
    }

    @Override
    public int getGridWidth() {
        return GRID_WIDTH;
    }

    @Override
    public int getGridHeight() {
        return GRID_HEIGHT;
    }

    @Override
    public String getName() {
        return "LED";
    }

    @Override
    public String getShortDescription() {
        return "LED dióda - svieti pri logickej 1; pravým tlačidlom zvoľ umiestnenie vývodu a farbu";
    }
}