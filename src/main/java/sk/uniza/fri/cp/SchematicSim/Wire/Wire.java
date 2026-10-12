package sk.uniza.fri.cp.SchematicSim.Wire;

import javafx.application.Platform;
import javafx.geometry.Point2D;
import javafx.scene.Group;
import javafx.scene.Node;
import javafx.scene.control.ContextMenu;
import javafx.scene.control.Menu;
import javafx.scene.control.RadioMenuItem;
import javafx.scene.control.ToggleGroup;
import javafx.scene.input.MouseEvent;
import javafx.scene.paint.Color;
import javafx.scene.shape.Line;
import javafx.scene.shape.Polyline;
import javafx.scene.shape.StrokeLineCap;
import sk.uniza.fri.cp.SchematicSim.Connectable;
import sk.uniza.fri.cp.SchematicSim.Electrical.PinType;
import sk.uniza.fri.cp.SchematicSim.Electrical.Potential;
import sk.uniza.fri.cp.SchematicSim.HighlightGroup;
import sk.uniza.fri.cp.SchematicSim.Pin.Pin;
import sk.uniza.fri.cp.SchematicSim.Sheet.SchematicSheet;
import sk.uniza.fri.cp.SchematicSim.Sheet.SheetEvent;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Vodič spájajúci piny súčiastok. Vytvára medzi nimi potenciál.
 * <p>
 * V novom modeli je vodič VŽDY jedna priama úsečka (vodorovná alebo zvislá):
 * <ul>
 *     <li>oba konce sú na pine/spájačoch, ktoré ležia na jednej osi, alebo</li>
 *     <li>vznikne zlom - vodič sa rozdelí na DVA vodiče spojené neviditeľným
 *         spájačom ({@link WireJunction}),</li>
 *     <li>počas ťahania/uvádzania sa zobrazuje L-tvarový náhľad cez dve čiary
 *         ({@code line} + {@code lineB}).</li>
 * </ul>
 * Trieda nerieši routing (ortogonálny router bol odstránený) - geometriu udržiava
 * {@link #updateGeometry()} a usporiadanie {@link #settleGeometry}.
 *
 * @author Tomáš Hianik (pôvodný autor), adaptácia pre SchematicSim
 */
public class Wire extends HighlightGroup {

    private static Color defaultColor = Color.BLACK;

    // debug farby podľa logického stavu vodiča: Z - sivá, 0 - modrá, 1 - červená
    private static final Color DEBUG_Z_COLOR = Color.GRAY;
    private static final Color DEBUG_LOW_COLOR = Color.BLUE;
    private static final Color DEBUG_HIGH_COLOR = Color.RED;

    /** Tolerancia pre zistenie zarovnania koncov (pozície sú násobky mriežky). */
    private static final double ALIGN_EPS = 0.5;

    /** Hrúbka čiarkovaného prekryvu zvýraznenia (výber/hover) - kreslí sa NAD čiarou. */
    private static final double HIGHLIGHT_WIDTH = 1;
    private static final double NORMAL_WIDTH = 2;

    private Color color;
    private Potential potential;
    private boolean debugColored;
    private volatile boolean colorRefreshScheduled;

    private final Runnable debugColorListener = this::refreshDebugColors;

    private final WireEnd[] ends;

    /** Základná čiara vodiča (priamy úsečok, alebo prvá rameno L-tvaru počas náhľadu). */
    private final Line line;

    /** Druhé rameno L-tvaru - viditeľné len počas tvorby/ťahania konca. */
    private final Line lineB;

    /**
     * Čiarkovaný prekryv zvýraznenia (inverzná farba) kreslený NAD základnou čiarou -
     * základná čiara si pri výbere zachováva svoju farbu (inak by napr. čierny vodič
     * na bielom pozadí pri výbere zbil do bielej a zmizol).
     */
    private final Polyline highlightLine;

    private final Group endsGroup;

    /**
     * Orientácia zarovnaného vodiča (true = vodorovný). Udržiava sa pri každej
     * zmen geometrie, keď sú konce zarovnané; počas ťahania slúži aj ako prvá
     * informácia o osi ešte pred zamknutím náhľadu.
     */
    private boolean horizontal = true;

    // === náhľad L-tvaru počas tvorby/ťahania ===

    private boolean preview;

    /** Zamknutá os náhľadu (null = ešte nezamknutá - čaká na smer počiatočného pohybu). */
    private Boolean previewAxis;

    /** Index konca, ktorý je počas náhľadu ukotvený (voľný koniec ho sleduje). */
    private int previewAnchor = 1;

    // === odložené usadenie geometrie ===

    private boolean settleScheduled;
    private WireEnd pendingSettleEnd;

    /** 0 = nezvýraznený; inak nepriehľadnosť čiarkovaného zvýraznenia. */
    private double highlightOpacity;

    /**
     * Vytvorenie nového vodiča začínajúceho na danom pine. Voľný koniec je dostupný cez
     * {@link #catchFreeEnd()}.
     */
    public Wire(Pin startPin) {
        this(startPin.getOwner().getSheet());
        this.ends[0].connect(startPin);
    }

    /**
     * Vytvorenie nového vodiča začínajúceho na spájači (WireJunction) - odbočka.
     * Voľný koniec je dostupný cez {@link #catchFreeEnd()}.
     */
    public Wire(WireJunction startJunction) {
        this(startJunction.getSheet());
        this.ends[0].connect(startJunction);
    }

    /**
     * Vytvorenie vodiča priamo na ploche bez okamžitého pripojenia koncov
     * (používa sa pri načítavaní súboru a pri lepení zo schránky).
     */
    public Wire(SchematicSheet sheet) {
        this.color = defaultColor;

        this.ends = new WireEnd[]{new WireEnd(sheet, this), new WireEnd(sheet, this)};

        this.line = createLine();
        this.lineB = createLine();
        this.lineB.setVisible(false);

        this.highlightLine = new Polyline();
        this.highlightLine.setStrokeLineCap(StrokeLineCap.ROUND);
        this.highlightLine.setStrokeWidth(HIGHLIGHT_WIDTH);
        this.highlightLine.getStrokeDashArray().setAll(6d, 4d);
        this.highlightLine.setMouseTransparent(true);
        this.highlightLine.setVisible(false);

        this.endsGroup = new Group(this.ends[0], this.ends[1]);
        this.getChildren().addAll(this.line, this.lineB, this.highlightLine, this.endsGroup);
        this.setId("wire");
        refreshLines();

        registerEvents();
    }

    private static Line createLine() {
        Line result = new Line();
        result.setStrokeLineCap(StrokeLineCap.ROUND);
        result.setStrokeWidth(NORMAL_WIDTH);
        return result;
    }

    public SchematicSheet getSheet() {
        return this.ends[0].getSheet();
    }

    public static void setDefaultColor(Color defColor) {
        defaultColor = defColor;
    }

    public static Color getDefaultColor() {
        return defaultColor;
    }

    public void changeColor(Color newColor) {
        this.color = newColor;
        for (WireEnd end : this.ends) end.setDefaultColor();
        refreshLines();
        if (this.isSelected()) applyHighlight(1);
    }

    public Color getColor() {
        return this.color;
    }

    /** Farby v kontextovom menu vodiča "Farba vodiča" (názov -> farba), v poradí menu. */
    public static final Map<String, Color> WIRE_COLORS = new LinkedHashMap<>();
    static {
        WIRE_COLORS.put("Čierna", Color.BLACK);
        WIRE_COLORS.put("Červená", Color.RED);
        WIRE_COLORS.put("Zelená", Color.GREEN);
        WIRE_COLORS.put("Modrá", Color.BLUE);
        WIRE_COLORS.put("Žltá", Color.YELLOW);
        WIRE_COLORS.put("Oranžová", Color.ORANGE);
        WIRE_COLORS.put("Šedá", Color.GRAY);
    }

    /**
     * Zmena farby celého vodiča: všetkých úsekov spojených cez ohyby (až po pin alebo viditeľný
     * spájač). Ak je vodič vybraný, zafarbia sa všetky vybrané vodiče.
     *
     * @param newColor Nová farba
     */
    public void setChainColor(Color newColor) {
        SchematicSheet sheet = getSheet();
        List<Wire> targets = this.isSelected() ? sheet.getSelectedWires() : java.util.Collections.singletonList(this);
        Set<Wire> coloured = new LinkedHashSet<>();
        for (Wire wire : targets) coloured.addAll(wire.collectChain());
        for (Wire wire : coloured) wire.changeColor(newColor);
        sheet.markChanged();
    }

    private void showColorMenu(double screenX, double screenY) {
        Menu colorMenu = new Menu("Farba vodiča");
        ToggleGroup group = new ToggleGroup();
        for (Map.Entry<String, Color> entry : WIRE_COLORS.entrySet()) {
            RadioMenuItem item = new RadioMenuItem(entry.getKey());
            item.setToggleGroup(group);
            item.setSelected(entry.getValue().equals(this.color));
            item.setOnAction(e -> setChainColor(entry.getValue()));
            colorMenu.getItems().add(item);
        }
        new ContextMenu(colorMenu).show(this, screenX, screenY);
    }

    /**
     * Zapnutie/vypnutie debug-farbenia vodiča podľa logického stavu potenciálu.
     * Pri prekreslení sa použije pôvodná (užívateľská) farba alebo debug-farba podľa stavu.
     */
    public void setDebugColored(boolean enabled) {
        this.debugColored = enabled;
        if (this.potential != null) {
            if (enabled) this.potential.addValueListener(this.debugColorListener);
            else this.potential.removeValueListener(this.debugColorListener);
        }
        refreshLines();
    }

    /**
     * Skoalescovaná obnova farieb pri zmene potenciálu - pri kontinuálnom behu simulácie
     * by každá zmena potenciálu inak vytvorila samostatnú runLater úlohu a FX vlákno by
     * nestíhalo vyprázdňovať rad. Spraví sa len najnovší stav.
     */
    private void refreshDebugColors() {
        if (!this.debugColored) return;
        if (this.colorRefreshScheduled) return;
        this.colorRefreshScheduled = true;
        Platform.runLater(() -> {
            this.colorRefreshScheduled = false;
            if (this.debugColored) refreshLines();
        });
    }

    /**
     * Aktuálne používaná farba čiary - debug-farba podľa stavu alebo užívateľská farba.
     */
    Color getCurrentColor() {
        if (!this.debugColored) return this.color;
        if (this.potential == null) return DEBUG_Z_COLOR;
        switch (this.potential.getValue()) {
            case HIGH: return DEBUG_HIGH_COLOR;
            case LOW: return DEBUG_LOW_COLOR;
            default: return DEBUG_Z_COLOR;
        }
    }

    /**
     * Obnova vzhľadu oboch čiar podľa aktuálnej farby. Základná čiara si VŽDY
     * zachováva svoju farbu (plná, hrubá podľa {@link #NORMAL_WIDTH}); výber/hover
     * sa zobrazí ako čiarkovaný inverzný prekryv {@code highlightLine} nad ňou.
     */
    private void refreshLines() {
        Color stroke = getCurrentColor();
        for (Line part : new Line[]{this.line, this.lineB}) {
            part.setStroke(stroke);
            part.setStrokeWidth(NORMAL_WIDTH);
            part.getStrokeDashArray().clear();
            part.setOpacity(1);
        }

        boolean highlighted = this.highlightOpacity > 0;
        this.highlightLine.setStroke(this.color.invert());
        this.highlightLine.setOpacity(highlighted ? this.highlightOpacity : 1);
        this.highlightLine.setVisible(highlighted);
    }

    private void applyHighlight(double opacity) {
        this.highlightOpacity = opacity;
        refreshLines();
    }

    public WireEnd[] getEnds() {
        return ends;
    }

    /**
     * Voľný koniec vodiča pri jeho prvotnom vytváraní.
     */
    public WireEnd catchFreeEnd() {
        return this.ends[1];
    }

    public boolean areBothEndsConnected() {
        return this.ends[0].isConnected() && this.ends[1].isConnected();
    }

    /** Spájač, z ktorého sa tento vodič začal ťahať (null pre vodič začatý na pine). */
    public WireJunction getStartJunction() {
        return this.ends[0].getJunction();
    }

    boolean isHorizontal() {
        return this.horizontal;
    }

    public boolean isPreview() {
        return this.preview;
    }

    // ---------------------------------------------------------------------------
    // Náhľad L-tvaru (tvorba vodiča, ťahanie konca, odbočka)
    // ---------------------------------------------------------------------------

    /**
     * Zapnutie náhľadu: koniec {@code anchorIndex} je ukotvený, druhý koniec sleduje
     * kurzor. Ak je {@code axis} null, os sa zamkne až pri prvom väčšom pohybe myši
     * (smer prvého ramena = väčší z súčiastok delta x / delta y).
     */
    public void beginPreview(int anchorIndex, Boolean axis) {
        this.preview = true;
        this.previewAnchor = anchorIndex;
        this.previewAxis = axis;
        updateGeometry();
    }

    public void endPreview() {
        if (!this.preview) return;
        // orientácia zvolená počas ťahania sa prenesie do hotového vodiča - inak by
        // usadenie oboch ukotvených koncov (splitAtConflict) použilo starú hodnotu
        // a L-tvar by sa otočil na opak toho, čo používateľ počas ťahania videl
        if (this.previewAxis != null) this.horizontal = this.previewAxis;
        this.preview = false;
        this.previewAxis = null;
        this.lineB.setVisible(false);
        updateGeometry();
    }

    /**
     * Posun voľného konca počas ťahania. Pred zamknutím osi sleduje voľný koniec
     * kurzor priamo; po zamknutí sa dokresľuje L-tvar (obe ramená).
     */
    public void updateCreationDrag(double x, double y) {
        if (!this.preview) return;

        WireEnd freeEnd = this.ends[1 - this.previewAnchor];
        freeEnd.moveTo(x, y);

        if (this.previewAxis == null) {
            Point2D anchor = this.ends[this.previewAnchor].getConnectionPoint();
            double deltaX = Math.abs(x - anchor.getX());
            double deltaY = Math.abs(y - anchor.getY());
            if (Math.max(deltaX, deltaY) >= 3) {
                this.previewAxis = deltaX >= deltaY;
            }
        }
        updateGeometry();
    }

    // ---------------------------------------------------------------------------
    // Geometria
    // ---------------------------------------------------------------------------

    /**
     * Prepočet vykreslenia podľa aktuálnych pozícií koncov. Počas náhľadu sa
     * dokresľuje L-tvar; hotový vodič je vždy jedna priama úsečka.
     */
    void updateGeometry() {
        Point2D p0 = this.ends[0].getConnectionPoint();
        Point2D p1 = this.ends[1].getConnectionPoint();

        if (this.preview) {
            Point2D anchor = this.ends[this.previewAnchor].getConnectionPoint();
            Point2D free = this.ends[1 - this.previewAnchor].getConnectionPoint();

            if (this.previewAxis == null) {
                // os ešte nie je zamknutá - kreslíme priamu čiaru od kotvy po kurzor
                setLine(this.line, anchor, free);
                this.lineB.setVisible(false);
            } else {
                Point2D corner = this.previewAxis
                        ? new Point2D(free.getX(), anchor.getY())
                        : new Point2D(anchor.getX(), free.getY());
                setLine(this.line, anchor, corner);
                setLine(this.lineB, corner, free);
                this.lineB.setVisible(true);
            }
        } else {
            setLine(this.line, p0, p1);
            this.lineB.setVisible(false);

            // udržanie orientácie pri zarovnaných koncoch
            if (sameCoordinate(p0.getY(), p1.getY())) {
                this.horizontal = true;
            } else if (sameCoordinate(p0.getX(), p1.getX())) {
                this.horizontal = false;
            }
        }

        syncHighlightGeometry();
    }

    /**
     * Geometria čiarkovaného prekryvu zvýraznenia kopíruje základnú čiaru
     * (a počas náhľadu aj druhé rameno L-tvaru).
     */
    private void syncHighlightGeometry() {
        javafx.collections.ObservableList<Double> points = this.highlightLine.getPoints();
        points.setAll(
                this.line.getStartX(), this.line.getStartY(),
                this.line.getEndX(), this.line.getEndY());
        if (this.lineB.isVisible()) {
            points.addAll(this.lineB.getEndX(), this.lineB.getEndY());
        }
    }

    private static void setLine(Line target, Point2D from, Point2D to) {
        target.setStartX(from.getX());
        target.setStartY(from.getY());
        target.setEndX(to.getX());
        target.setEndY(to.getY());
    }

    private static boolean sameCoordinate(double a, double b) {
        return Math.abs(a - b) < ALIGN_EPS;
    }

    // ---------------------------------------------------------------------------
    // Kaskáda pohybu (posun súčiastky / spájača)
    // ---------------------------------------------------------------------------

    /**
     * Posunutie JEDNEHO konca vodiča (volá sa z listenera pinu, keď sa presunie
     * súčiastka). Kolomponenta pohybu sa podľa orientácie tohto vodiča prenesie
     * na spájač na druhom konci (spájač sa pohne len kolmo na tento vodič),
     * rovnobežná zložka znamená natiahnutie. Voľný koniec absorbuje celý posun.
     */
    void onEndMoved(WireEnd end, double deltaX, double deltaY) {
        if (this.preview || (deltaX == 0 && deltaY == 0)) {
            updateGeometry();
            return;
        }

        WireEnd other = otherEnd(end);
        if (!other.isConnected()) {
            other.moveTo(other.getLayoutX() + deltaX, other.getLayoutY() + deltaY);
        } else if (other.getJunction() != null) {
            // pohyb spájača: len kolmá zložka voči tomuto vodiči
            double moveX = 0;
            double moveY = 0;
            if (this.horizontal) moveY = deltaY;
            else moveX = deltaX;
            if (moveX != 0 || moveY != 0) {
                other.getJunction().moveTo(
                        other.getJunction().getLayoutX() + moveX,
                        other.getJunction().getLayoutY() + moveY);
            }
        } else {
            // obe konce ukotvené (pin) - kolmá zložka sa musí usadiť (odložene,
            // aby sa neriešili prechodné stavy uprostred kaskády)
            boolean perpMoved = this.horizontal ? deltaY != 0 : deltaX != 0;
            if (perpMoved) scheduleSettle(end);
        }
        updateGeometry();
    }

    /**
     * Posunutie spájača, na ktorom tento vodič končí (volá sa z listenera spájača).
     * Voľný koniec absorbuje celý posun; ak je druhý koniec ukotvený, naplánuje sa
     * odložené usadenie geometrie. Kaskáda cez ďalšie spájače sa nerieši priamo -
     * každý vodič reaguje len na pohyb svojho vlastného konca.
     */
    void onJunctionMoved(WireEnd end, double deltaX, double deltaY) {
        if (this.preview) {
            updateGeometry();
            return;
        }

        WireEnd other = otherEnd(end);
        if (!other.isConnected()) {
            other.moveTo(other.getLayoutX() + deltaX, other.getLayoutY() + deltaY);
        } else {
            scheduleSettle(end);
        }
        updateGeometry();
    }

    private static WireEnd otherEnd(Wire w, WireEnd end) {
        return w.ends[0] == end ? w.ends[1] : w.ends[0];
    }

    private WireEnd otherEnd(WireEnd end) {
        return otherEnd(this, end);
    }

    // ---------------------------------------------------------------------------
    // Usadenie geometrie (zarovnanie / rozdelenie na zlom)
    // ---------------------------------------------------------------------------

    /**
     * Odložené usadenie geometrie vodiča po pohybe konca. Spracuje sa až po dokončení
     * aktuálneho prechodu udalostí ({@code Platform.runLater}), aby sa neriešili
     * prechodné stavy kaskády. Viacnásobné volania sa spájajú (posledné pohnutý koniec).
     */
    void scheduleSettle(WireEnd end) {
        if (this.preview) return;
        if (WireEnd.isGrabbing(this)) return;
        if (Pin.getInProgressWire() == this) return;

        this.pendingSettleEnd = end;
        if (this.settleScheduled) return;
        this.settleScheduled = true;
        try {
            Platform.runLater(this::runSettle);
        } catch (IllegalStateException ex) {
            // FX toolkit nie je inicializovaný - usadíme synchronne
            this.settleScheduled = false;
            runSettle();
        }
    }

    private void runSettle() {
        this.settleScheduled = false;
        WireEnd moving = this.pendingSettleEnd;
        this.pendingSettleEnd = null;

        if (this.getParent() == null) return;
        if (this.preview || WireEnd.isGrabbing(this) || Pin.getInProgressWire() == this) return;
        if (moving == null || moving.getWire() != this) moving = this.ends[1];

        settleGeometry(moving);
        WireJunction.processNow();
    }

    /**
     * Usadenie geometrie: zarovnané konce = len prepočet; obe ukotvené mimo osi =
     * rozdelenie vodiča na zlom ({@link #splitAtConflict}); jeden voľný koniec =
     * zarovnanie voľného konca na os kotvy a na mriežku.
     */
    private void settleGeometry(WireEnd moving) {
        if (this.getParent() == null || this.preview) return;
        if (WireEnd.isGrabbing(this) || Pin.getInProgressWire() == this) return;

        WireEnd fixed = otherEnd(moving);
        Point2D movingPoint = moving.getConnectionPoint();
        Point2D fixedPoint = fixed.getConnectionPoint();

        if (sameCoordinate(movingPoint.getY(), fixedPoint.getY())
                || sameCoordinate(movingPoint.getX(), fixedPoint.getX())) {
            this.horizontal = sameCoordinate(movingPoint.getY(), fixedPoint.getY());
            updateGeometry();
            return;
        }

        if (moving.isConnected() && fixed.isConnected()) {
            splitAtConflict(moving);
            return;
        }
        if (!moving.isConnected() && !fixed.isConnected()) {
            updateGeometry();
            return;
        }
        alignFreeEnd(moving.isConnected() ? fixed : moving);
    }

    /**
     * Zarovnanie voľného konca: os sa zvolí podľa väčšej súčiastky posunu od kotvy
     * a voľný koniec sa posunie na os kotvy (kolmo) a na mriežku (po osi).
     */
    private void alignFreeEnd(WireEnd freeEnd) {
        WireEnd anchor = otherEnd(freeEnd);
        Point2D anchorPoint = anchor.getConnectionPoint();
        Point2D freePoint = freeEnd.getConnectionPoint();

        double deltaX = freePoint.getX() - anchorPoint.getX();
        double deltaY = freePoint.getY() - anchorPoint.getY();
        this.horizontal = Math.abs(deltaX) >= Math.abs(deltaY);

        double grid = getSheet().getGrid().getSizeMin();
        if (this.horizontal) {
            freeEnd.moveTo(snapToGrid(freePoint.getX(), grid), anchorPoint.getY());
        } else {
            freeEnd.moveTo(anchorPoint.getX(), snapToGrid(freePoint.getY(), grid));
        }
        updateGeometry();
    }

    /**
     * Rozdelenie vodiča v momente, keď jeho zarovnané konce prestali ležať na jednej
     * osi (napr. po presune súčiastky kolmo na vodič). Vznikne zlom - spájač v rohu a
     * nový vodič od zlomu po pôvodný presunutý koniec.
     *
     * @return vytvorený spájač, alebo null ak nebolo čo rozdeľovať
     */
    private WireJunction splitAtConflict(WireEnd moving) {
        WireEnd fixed = otherEnd(moving);
        Point2D movingPoint = moving.getConnectionPoint();
        Point2D fixedPoint = fixed.getConnectionPoint();

        Point2D corner = this.horizontal
                ? new Point2D(movingPoint.getX(), fixedPoint.getY())
                : new Point2D(fixedPoint.getX(), movingPoint.getY());

        if (corner.distance(movingPoint) < ALIGN_EPS || corner.distance(fixedPoint) < ALIGN_EPS) {
            // už kolínné v druhej osi - len opravíme orientáciu
            if (sameCoordinate(movingPoint.getY(), fixedPoint.getY())) this.horizontal = true;
            else if (sameCoordinate(movingPoint.getX(), fixedPoint.getX())) this.horizontal = false;
            updateGeometry();
            return null;
        }
        return splitAt(moving, corner);
    }

    /**
     * Rozdelenie vodiča v bode {@code corner}: presúvaný koniec sa odpojí od cieľa,
     * pripojí sa na nový spájač v {@code corner} a vznikne nový vodič spájajúci
     * spájač s pôvodným cieľom presúvaného konca (alebo s jeho pozíciou, ak bol
     * voľný). Pôvodný vodič si ponechá nepohnutý koniec.
     *
     * @return vytvorený spájač
     */
    WireJunction splitAt(WireEnd movingEnd, Point2D corner) {
        Connectable target = movingEnd.getPin() != null ? movingEnd.getPin() : movingEnd.getJunction();
        Point2D oldPosition = movingEnd.getConnectionPoint();

        movingEnd.disconnect();

        WireJunction junction = WireJunction.at(getSheet(), corner.getX(), corner.getY());
        movingEnd.connect(junction);

        Wire newWire = new Wire(getSheet());
        newWire.changeColor(this.color);
        getSheet().addItem(newWire);
        WireEnd start = newWire.ends[0];
        WireEnd finish = newWire.ends[1];
        start.connect(junction);
        if (target != null) {
            finish.connect(target);
        } else {
            finish.moveTo(oldPosition.getX(), oldPosition.getY());
        }

        // orientácia nového vodiča podľa reálnej geometrie
        Point2D a = start.getConnectionPoint();
        Point2D b = finish.getConnectionPoint();
        newWire.horizontal = Math.abs(b.getY() - a.getY()) <= Math.abs(b.getX() - a.getX());

        updateGeometry();
        newWire.updateGeometry();
        updatePotentialNetwork();
        return junction;
    }

    /**
     * Rozdelenie tohto vodiča v bode {@code position} (pustenie konca iného vodiča
     * naň, alebo začatie odbočky ťahaním zo stredu vodiča). Bod sa zarovná na mriežku
     * a na os vodiča; vytvorí sa spájač a vodič sa rozdelí na dve priame časti.
     *
     * @return vytvorený spájač, alebo null ak je bod príliš blízko konca vodiča
     */
    public WireJunction splitAtPoint(Point2D position) {
        if (this.preview) return null;

        Point2D p0 = this.ends[0].getConnectionPoint();
        Point2D p1 = this.ends[1].getConnectionPoint();
        boolean isHorizontalLine = sameCoordinate(p0.getY(), p1.getY());
        boolean isVerticalLine = sameCoordinate(p0.getX(), p1.getX());
        if (!isHorizontalLine && !isVerticalLine) return null;

        double grid = getSheet().getGrid().getSizeMin();
        double snapX = snapToGrid(position.getX(), grid);
        double snapY = snapToGrid(position.getY(), grid);

        Point2D cut;
        if (isHorizontalLine) {
            double minX = Math.min(p0.getX(), p1.getX());
            double maxX = Math.max(p0.getX(), p1.getX());
            cut = new Point2D(clamp(snapX, minX, maxX), p0.getY());
        } else {
            double minY = Math.min(p0.getY(), p1.getY());
            double maxY = Math.max(p0.getY(), p1.getY());
            cut = new Point2D(p0.getX(), clamp(snapY, minY, maxY));
        }

        double distance0 = cut.distance(p0);
        double distance1 = cut.distance(p1);
        if (Math.min(distance0, distance1) < grid / 2.0) return null;

        WireEnd movingEnd = distance0 >= distance1 ? this.ends[0] : this.ends[1];
        return splitAt(movingEnd, cut);
    }

    private static double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }

    private static double snapToGrid(double value, double grid) {
        return Math.round(value / grid) * grid;
    }

    /**
     * Dokončenie vytvárania vodiča: vypne náhľad, zarovná voľné konce na mriežku,
     * usadí geometriu a spracuje čakajúce spájače. Ak bol ťah ukončený na voľnom
     * mieste v L-tvarovej polohe, zachovajú sa obe ramená ako dva vodiče.
     */
    public void completeCreation() {
        endPreview();
        double grid = getSheet().getGrid().getSizeMin();
        for (WireEnd end : this.ends) {
            if (!end.isConnected()) {
                end.moveTo(snapToGrid(end.getLayoutX(), grid), snapToGrid(end.getLayoutY(), grid));
            }
        }
        if (!materializeElbow(grid)) {
            settleGeometry(this.ends[1]);
        }
        WireJunction.processNow();
    }

    /**
     * Ukončenie ťahu L-tvarom na voľnom mieste: obe ramená náhľadu sa zachovajú
     * ako DVA vodiče spojené neviditeľným zlomom (prvý koniec tohto vodiča sa
     * presunie do rohu, nový vodič pokračuje z rohu po miesto pustenia). Druhé
     * rameno sa vytvorí len ak nie je príliš krátke (aspoň polovica mriežky) -
     * vtedy sa nechá klasické zarovnanie na jednu priamu úsečku.
     *
     * @param grid veľkosť mriežky (práh pre minimálnu dĺžku druhého ramena)
     * @return {@code true} ak vznikol zlom a vodič sa už ďalej neusadzuje
     */
    private boolean materializeElbow(double grid) {
        WireEnd anchor = this.ends[0];
        WireEnd free = this.ends[1];
        if (!anchor.isConnected() || free.isConnected()) return false;

        Point2D dropPoint = free.getConnectionPoint();
        Point2D corner = this.horizontal
                ? new Point2D(dropPoint.getX(), anchor.getLayoutY())
                : new Point2D(anchor.getLayoutX(), dropPoint.getY());

        // nulová prvá časť = roh na kotve (nulový vodič + spájač na pine) - neriešime
        if (corner.distance(anchor.getLayoutX(), anchor.getLayoutY()) < ALIGN_EPS) return false;

        double secondArm = corner.distance(dropPoint);
        if (secondArm < grid / 2.0) return false;

        WireJunction junction = WireJunction.at(getSheet(), corner.getX(), corner.getY());
        free.moveTo(corner.getX(), corner.getY());
        free.connect(junction);

        Wire tail = new Wire(getSheet());
        tail.changeColor(this.color);
        getSheet().addItem(tail);
        tail.ends[0].connect(junction);
        tail.ends[1].moveTo(dropPoint.getX(), dropPoint.getY());
        tail.updateGeometry();
        updateGeometry();
        return true;
    }

    /**
     * Prepočet geometrie po dokončení vodiča so zarovnaním voľných koncov na mriežku
     * (používa sa pri lepení zo schránky).
     */
    public void settleToGrid() {
        endPreview();
        double grid = getSheet().getGrid().getSizeMin();
        for (WireEnd end : this.ends) {
            if (!end.isConnected()) {
                end.moveTo(snapToGrid(end.getLayoutX(), grid), snapToGrid(end.getLayoutY(), grid));
            }
        }
        settleGeometry(this.ends[1]);
        WireJunction.processNow();
    }

    /**
     * Pripojí voľné konce vodičov, pod ktoré doľahnú piny presúvaných súčiastok
     * (opačný smer než bežné ťahanie vodiča na pin). Každý pin sa spojí s prvým
     * voľným koncom v polovici mriežky - rovnaká tolerancia ako pri pustení konca
     * vodiča na pin. Volá sa po pustení presunutej súčiastky.
     */
    public static void connectFreeEndsToPins(SchematicSheet sheet, Iterable<Pin> pins) {
        double tolerance = sheet.getGrid().getSizeMin() / 2.0;
        double scale = sheet.getAppliedScale();
        List<Wire> wires = sheet.getWires();

        for (Pin pin : pins) {
            if (pin == null || pin.isOccupied()) continue;
            Point2D pinPos = pin.getSceneGridPosition();
            double pinX = pinPos.getX() / scale;
            double pinY = pinPos.getY() / scale;

            for (Wire wire : wires) {
                if (wire.getParent() == null || wire.isPreview() || wire == Pin.getInProgressWire()) {
                    continue;
                }
                for (WireEnd end : wire.getEnds()) {
                    if (end.isConnected()) continue;
                    double dx = end.getLayoutX() - pinX;
                    double dy = end.getLayoutY() - pinY;
                    if (dx * dx + dy * dy <= tolerance * tolerance) {
                        end.connect(pin);
                        wire.scheduleSettle(end);
                        break;
                    }
                }
                if (pin.isOccupied()) break;
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Výber, zvýraznenie a udalosti
    // ---------------------------------------------------------------------------

    private void registerEvents() {
        // Klik na vodič: výber (pravý klik = reťazec medzi ukotveniami), dvojklik na
        // konci = zmazanie vodiča. Spracúva sa TU (capture filter), aby sa zabránilo
        // výberu samotného konca/spájača aj presunu cez Movable.
        this.addEventFilter(MouseEvent.MOUSE_PRESSED, event -> {
            if (!event.isPrimaryButtonDown()) return;

            boolean onWireEnd = targetInEndChain(event.getTarget());
            if (event.getClickCount() >= 2 && onWireEnd && getSheet().isEditingEnabled()) {
                delete();
                event.consume();
                return;
            }

            SchematicSheet sheet = getSheet();
            if (event.isShortcutDown() && !event.isShiftDown()) {
                sheet.clearSelect();
                for (Wire chainWire : collectChain()) {
                    sheet.addSelect(chainWire);
                }
            } else if (event.isShiftDown()) {
                if (isSelected()) sheet.removeSelect(this);
                else sheet.addSelect(this);
            } else {
                sheet.clearSelect();
                sheet.addSelect(this);
            }
            event.consume();
        });

        // ťah zo stredu vodiča = rozdelenie na spájač a tvorba odbočky
        this.addEventFilter(MouseEvent.DRAG_DETECTED, event -> {
            if (!event.isPrimaryButtonDown()) return;
            if (!getSheet().isEditingEnabled()) return;
            if (targetInEndChain(event.getTarget())) return; // ťah z konca rieši WireEnd
            if (this.preview) return;

            Point2D sheetXY = getSheet().sceneToSheet(event.getSceneX(), event.getSceneY());
            double grid = getSheet().getGrid().getSizeMin();
            WireJunction junction = WireJunction.findNear(getSheet(), sheetXY, grid / 2.0);
            if (junction == null) junction = splitAtPoint(sheetXY);
            if (junction == null) return;

            Pin.beginWireCreation(junction);
            this.startFullDrag();
            event.consume();
        });

        this.addEventFilter(MouseEvent.MOUSE_DRAGGED, event -> {
            Wire inProgress = Pin.getInProgressWire();
            if (inProgress == null) return;
            Point2D sheetXY = getSheet().sceneToSheet(event.getSceneX(), event.getSceneY());
            inProgress.updateCreationDrag(sheetXY.getX(), sheetXY.getY());
            event.consume();
        });

        this.addEventFilter(MouseEvent.MOUSE_RELEASED, event -> {
            if (Pin.getInProgressWire() == null) return;
            Pin.finishInProgressWire();
            event.consume();
        });

        // pravy klik: kontextove menu s farbou vodica
        this.setOnContextMenuRequested(event -> {
            if (getSheet() == null || !getSheet().isEditingEnabled() || this.preview) return;
            showColorMenu(event.getScreenX(), event.getScreenY());
            event.consume();
        });

        this.addEventHandler(MouseEvent.MOUSE_ENTERED_TARGET, event -> {
            if (!this.isSelected()) applyHighlight(0.7);
            Color brighter = this.color.brighter();
            this.setStyle("-fx-effect: dropshadow(gaussian, rgb("
                    + brighter.getRed() * 255 + "," + brighter.getGreen() * 255 + "," + brighter.getBlue() * 255 + "), 1, 1.0, 0, 0)");
        });

        this.addEventHandler(MouseEvent.MOUSE_EXITED_TARGET, event -> {
            if (!this.isSelected()) applyHighlight(0);
            this.setStyle("-fx-effect: none");
        });
    }

    /**
     * Je prekliknutý uzol (alebo jeho rodič) koncom tohto vodiča ({@link WireEnd})?
     */
    private boolean targetInEndChain(Object target) {
        Node node = target instanceof Node ? (Node) target : null;
        while (node != null && node != this) {
            if (node instanceof WireEnd) return true;
            node = node.getParent();
        }
        return false;
    }

    /**
     * Reťazec vodičov medzi ukotveniami: prechod cez neviditeľné spájače (presne dva
     * vodiče), zastavenie na pine, viditeľných spájačoch a voľných koncoch. Používa sa
     * pri Ctrl+klike na vodič.
     */
    List<Wire> collectChain() {
        List<Wire> result = new ArrayList<>();
        Set<Wire> visited = new HashSet<>();
        LinkedList<Wire> queue = new LinkedList<>();

        visited.add(this);
        queue.add(this);
        result.add(this);

        while (!queue.isEmpty()) {
            Wire current = queue.poll();
            for (WireEnd end : current.ends) {
                WireJunction junction = end.getJunction();
                if (junction == null || !junction.isCrossable()) continue;
                for (Wire neighbour : junction.getConnectedWires()) {
                    if (neighbour == null || !visited.add(neighbour)) continue;
                    result.add(neighbour);
                    queue.add(neighbour);
                }
            }
        }
        return result;
    }

    /**
     * Vzdialenosť od bodu k osi tohto vodiča (pre výber najbližšieho vodiča pri
     * pustení konca v okolí).
     */
    public double distanceToPoint(Point2D position) {
        if (this.preview) return Double.MAX_VALUE;
        Point2D p0 = this.ends[0].getConnectionPoint();
        Point2D p1 = this.ends[1].getConnectionPoint();
        return distanceToSegment(position.getX(), position.getY(), p0.getX(), p0.getY(), p1.getX(), p1.getY());
    }

    private static double distanceToSegment(double px, double py, double x1, double y1, double x2, double y2) {
        double dx = x2 - x1;
        double dy = y2 - y1;
        double lenSq = dx * dx + dy * dy;
        if (lenSq == 0) return Math.hypot(px - x1, py - y1);
        double t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
        double projX = x1 + t * dx;
        double projY = y1 + t * dy;
        return Math.hypot(px - projX, py - projY);
    }

    @Override
    public void delete() {
        super.delete();

        if (this.getParent() == null) return; // už odstránený (napr. po zlúčení susedov)

        getSheet().removeSelect(this);

        // odpojenie koncov uvoľní piny/spájače; spájače sa cez dirty množinu
        // následne prepočítajú (zničia sa nepotrebné, zlúčia sa kolineárne vodiče)
        for (WireEnd end : this.ends) {
            end.disconnect();
        }
        this.getSheet().removeItem(this);
        WireJunction.processNow();
    }

    @Override
    public void select() {
        super.select();
        if (!this.isSelectable()) return;
        applyHighlight(1);
    }

    @Override
    public void deselect() {
        super.deselect();
        applyHighlight(0);
    }

    // ---------------------------------------------------------------------------
    // Potenciály
    // ---------------------------------------------------------------------------

    /**
     * Prepočet potenciálu vodiča podľa aktuálne pripojených pinov na jeho koncoch.
     * Podporuje pripojenie cez spájače (WireJunction) - nájde pin aj cez reťaz zlomov.
     */
    void updatePotential() {
        Pin start = null;
        Pin end = null;
        if (this.ends[0] != null && this.ends[1] != null) {
            start = getEndPin(this.ends[0]);
            end = getEndPin(this.ends[1]);
        }
        placePotential(start, end);
    }

    /**
     * Odpojí starý a vytvorí nový potenciál tohto vodiča medzi danými piny.
     */
    private void placePotential(Pin start, Pin end) {
        if (this.potential != null) {
            this.potential.removeValueListener(this.debugColorListener);
            this.potential.detach();
            this.potential = null;
        }

        if (start != null && end != null) {
            this.potential = new Potential(start, end);
            if (this.debugColored) this.potential.addValueListener(this.debugColorListener);
        }

        if (this.ends[0] != null && this.ends[1] != null) {
            Pin toUpdate = start != null ? start : end;
            if (toUpdate != null && getSheet().simRunningProperty().getValue()) {
                getSheet().addEvent(new SheetEvent(toUpdate));
            }
        }
        refreshLines();
    }

    /**
     * Prepočíta potenciály všetkých vodičov v elektrickej sieti okolo tohto vodiča
     * (cez spájače). Volá sa po každej zmene topológie (pripojenie/odpojenie konca,
     * rozdelenie vodiča spájačom).
     * <p>
     * Obnova prebieha v dvoch fázach: najprv sa vyresolve-ujú piny všetkých vodičov
     * a ticho odpoja ich staré potenciály (bez kaskády - inak by sa reťaze počas
     * búrania prepojovali v náhodnom poradí), potom sa nové potenciály stavajú rastom
     * OD BUDIČOV: ako prvé vodiče dotýkajúce sa výstupných pinov, ďalej cez zdieľané
     * piny. Každý ďalší vodič sa tak naviaže na už postavený (OUT-ový) chvost reťaze
     * namiesto dvoch neobsadených listov, z ktorých by dostal typ IN a hodnotu NC
     * (trvalo sivú debug-farbu). Poradie konečných vodičov tak už nehrá úlohu.
     */
    void updatePotentialNetwork() {
        // 1) zbierka vodičov siete cez spájače (BFS)
        Set<Wire> visited = new LinkedHashSet<>();
        LinkedList<Wire> queue = new LinkedList<>();
        visited.add(this);
        queue.add(this);
        while (!queue.isEmpty()) {
            Wire wire = queue.poll();
            for (WireEnd end : wire.ends) {
                if (end == null) continue;
                WireJunction junction = end.getJunction();
                if (junction == null) continue;
                for (WireEnd other : junction.getConnectedEnds()) {
                    Wire next = other.getWire();
                    if (next != null && visited.add(next)) queue.add(next);
                }
            }
        }

        // 2) resolve protiľahlých pinov všetkých vodičov (čistý dotaz, bez zmeny)
        Map<Wire, Pin[]> resolved = new LinkedHashMap<>();
        for (Wire w : visited) {
            Pin s = (w.ends[0] != null) ? w.getEndPin(w.ends[0]) : null;
            Pin e = (w.ends[1] != null) ? w.getEndPin(w.ends[1]) : null;
            resolved.put(w, new Pin[]{s, e});
        }

        // 3) tiché odpojenie starých potenciálov - žiadna kaskáda, reťaze sa zboria
        //    naraz a listy pinov ostanú prázdne pre novú stavbu
        for (Wire w : visited) {
            if (w.potential != null) {
                w.potential.removeValueListener(w.debugColorListener);
                w.potential.detach();
                w.potential = null;
            }
        }

        // 4) index pin -> vodiče (pre rast cez zdieľané piny)
        Map<Pin, List<Wire>> byPin = new HashMap<>();
        for (Map.Entry<Wire, Pin[]> entry : resolved.entrySet()) {
            for (Pin p : entry.getValue()) {
                if (p == null) continue;
                byPin.computeIfAbsent(p, k -> new ArrayList<>()).add(entry.getKey());
            }
        }

        // 5) rast od budičov: prvé vodiče dotýkajúce sa výstupných pinov, potom
        //    šírenie cez zdieľané piny; až nakoniec zvyšky bez budiča
        Set<Wire> placed = new LinkedHashSet<>();
        LinkedList<Wire> placeQueue = new LinkedList<>();
        for (Wire w : visited) {
            if (touchesDriver(resolved.get(w)) && placed.add(w)) placeQueue.add(w);
        }
        while (!placeQueue.isEmpty()) {
            Wire w = placeQueue.poll();
            Pin[] pins = resolved.get(w);
            w.placePotential(pins[0], pins[1]);
            for (Pin p : pins) {
                if (p == null) continue;
                for (Wire neighbour : byPin.get(p)) {
                    if (placed.add(neighbour)) placeQueue.add(neighbour);
                }
            }
        }
        for (Wire w : visited) {
            if (placed.add(w)) {
                Pin[] pins = resolved.get(w);
                w.placePotential(pins[0], pins[1]);
            }
        }
    }

    /** Či niektorý z pinov vodiča je výstupný (budič) - od neho sa stavia reťaz. */
    private static boolean touchesDriver(Pin[] pins) {
        for (Pin p : pins) {
            if (p == null) continue;
            PinType type = p.getOwnedPotential().getType();
            if (type != null && type != PinType.IN && type != PinType.NC) return true;
        }
        return false;
    }

    /**
     * Nájde pin, na ktorý je koniec vodiča napojený (priamo alebo cez spájač).
     * Spájač sa prechádza BEZ vodiča {@code this} - inak by vodič práve napojený na
     * novovytvorený spájač našiel ako prvý sám seba (spájač ho má vo svojich koncoch)
     * a dostal by potenciál (pin, pin) namiesto prepojenia na zvyšok siete.
     */
    private Pin getEndPin(WireEnd end) {
        if (end.getPin() != null) return end.getPin();
        if (end.getJunction() != null) return end.getJunction().findConnectedPin(this);
        return null;
    }
}
