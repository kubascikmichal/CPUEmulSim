package sk.uniza.fri.cp.SchematicSim.Sheet;

import javafx.application.Platform;
import javafx.beans.property.BooleanProperty;
import javafx.beans.property.ReadOnlyBooleanProperty;
import javafx.beans.property.SimpleBooleanProperty;
import javafx.beans.property.SimpleDoubleProperty;
import javafx.beans.value.ChangeListener;
import javafx.event.Event;
import javafx.event.EventHandler;
import javafx.geometry.Bounds;
import javafx.geometry.Point2D;
import javafx.geometry.Pos;
import javafx.scene.Group;
import javafx.scene.Node;
import javafx.scene.control.ScrollPane;
import javafx.scene.input.KeyCode;
import javafx.scene.input.KeyCodeCombination;
import javafx.scene.input.KeyCombination;
import javafx.scene.input.MouseButton;
import javafx.scene.input.MouseDragEvent;
import javafx.scene.input.MouseEvent;
import javafx.scene.layout.Pane;
import javafx.scene.layout.StackPane;
import javafx.scene.paint.Color;
import javafx.scene.shape.Rectangle;
import sk.uniza.fri.cp.SchematicSim.Gates.GateSymbol;
import sk.uniza.fri.cp.SchematicSim.GridOccupancy;
import sk.uniza.fri.cp.SchematicSim.GridSystem;
import sk.uniza.fri.cp.SchematicSim.Item;
import sk.uniza.fri.cp.SchematicSim.Selectable;
import sk.uniza.fri.cp.SchematicSim.Wire.Joint;
import sk.uniza.fri.cp.SchematicSim.Wire.Wire;
import sk.uniza.fri.cp.SchematicSim.Wire.WireEnd;
import sk.uniza.fri.cp.SchematicSim.Wire.WireJunction;
import sk.uniza.fri.cp.SchematicSim.Pin.Pin;

import java.lang.reflect.InvocationTargetException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Plocha simulátora - schematický editor. Nahrádza {@code Board} z BreadboardSim.
 * <p>
 * Kľúčové rozdiely oproti originálu:
 * <ul>
 *     <li>Na začiatku je plocha PRÁZDNA - žiadna počiatočná vývojová doska.</li>
 *     <li>Umiestňovanie súčiastok kontroluje voľnosť buniek mriežky cez {@link GridOccupancy}
 *     namiesto kolíznej detekcie pin↔soket.</li>
 *     <li>Zoom/pan mechanizmus je prispôsobený: pri zome zostáva bod plochy pod kurzorom
 *     na mieste (pôvodné riešenie z Board nastavovalo posun skôr, než sa prepočítal rozsah scrollbaru).</li>
 * </ul>
 *
 * @author Tomáš Hianik (pôvodný autor Board), adaptácia pre SchematicSim
 */
public class SchematicSheet extends ScrollPane {

    private final double widthPx;
    private final double heightPx;

    private final SchematicSimulator simulator;
    private final GridSystem gridSystem;
    private final SheetLayersManager layersManager;
    private GridOccupancy occupancy;

    private final ArrayList<Selectable> selected;
    private GateSymbol addingItem;

    /** Schránka pre kopírovanie/prilepenie vybratých súčiastok a vodičov (Ctrl+C / Ctrl+V). */
    private List<CopiedGate> clipboardGates = new ArrayList<>();
    private List<CopiedWire> clipboardWires = new ArrayList<>();
    private int clipboardBaseX;
    private int clipboardBaseY;

    /** Prebiehajúce označovanie obdĺžnikom (Shift + ťah ľavým tlačidlom) - kotva v súradniciach plochy. */
    private Rectangle rubberBand;
    private double rubberStartX;
    private double rubberStartY;

    /** Posledná poloha myši v scénových súradniciach - kotva pre prilepenie (Ctrl+V). */
    private double lastMouseSceneX = -1;
    private double lastMouseSceneY = -1;

    private boolean hasChanged = false;

    /** Povolenie editácie schémy (pridávanie/mazanie/presun vodičov a súčiastok). */
    private final SimpleBooleanProperty editingEnabled = new SimpleBooleanProperty(true);

    /** Debug-farbenie vodičov podľa logického stavu (Z sivá, 0 modrá, 1 červená). */
    private final SimpleBooleanProperty debugWires = new SimpleBooleanProperty(false);

    private static final double SCALE_DELTA = 1.1;

    /**
     * Vzdialenosť (v bodoch schémy) medzi pustením konca vodiča a najbližším segmentom,
     * pri ktorej ešte vznikne spoj, ak pick netrafil samotný vodič. Rovnaká ako pri
     * pinoch a spájačoch (polovica mriežky = 5 px).
     */
    private static final double WIRE_DROP_TOLERANCE = 5;
    private final SimpleDoubleProperty scaleTotal = new SimpleDoubleProperty(1);
    //pan sa spustí len vtedy, ak stlačenie začalo na prázdnej ploche (nie na súčiastke,
    //vodiči, spájači či pine) - inak by pri začatí ťahu prvku plocha o kúsok ušla
    private boolean panAllowed = false;
    private final Group contentGroup;

    private final EventHandler<MouseDragEvent> onMouseDragEnteredHandle = event -> {
        if (!isEditingEnabled()) return;
        hasChanged = true;
        if (addingItem == null && event.getGestureSource() instanceof Item) {
            Item item = (Item) event.getGestureSource();
            SchematicSheet sheet = (SchematicSheet) event.getSource();

            try {
                addingItem = (GateSymbol) item.getClass().getConstructor(SchematicSheet.class).newInstance(sheet);
                addItem(addingItem);
                Event.fireEvent(addingItem, new MouseEvent(MouseEvent.MOUSE_DRAGGED, event.getSceneX(), event.getSceneY(),
                        event.getScreenX(), event.getScreenY(), MouseButton.PRIMARY, 1, true,
                        true, true, true, true, true,
                        true, true, true, true, null));
            } catch (InstantiationException | IllegalAccessException | InvocationTargetException | NoSuchMethodException e) {
                e.printStackTrace();
            }
        }
    };

    private final EventHandler<MouseDragEvent> onMouseDragOverHandle = event -> {
        if (addingItem != null) {
            Event.fireEvent(addingItem, new MouseEvent(MouseEvent.MOUSE_DRAGGED, event.getSceneX(), event.getSceneY(),
                    event.getScreenX(), event.getScreenY(), MouseButton.PRIMARY, 1, true,
                    true, true, true, true, true,
                    true, true, true, true, null));
        }
    };

    private final EventHandler<MouseDragEvent> onMouseDragReleasedHandle = event -> {
        if (addingItem != null) {
            occupancy.occupy(addingItem);
            Event.fireEvent(addingItem, new MouseEvent(MouseEvent.MOUSE_RELEASED, event.getSceneX(), event.getSceneY(),
                    event.getScreenX(), event.getScreenY(), MouseButton.PRIMARY, 1, true,
                    true, true, true, true, true,
                    true, true, true, true, null));
            addingItem = null;
        }
    };

    private final EventHandler<MouseDragEvent> onMouseDragExitedHandle = event -> {
        if (addingItem != null) {
            addingItem.delete();
            addingItem = null;
        }
        event.consume();
    };

    public SchematicSheet(double width, double height, int gridSizePx) {
        this.widthPx = width;
        this.heightPx = height;
        this.selected = new ArrayList<>();
        this.simulator = new SchematicSimulator();
        this.gridSystem = new GridSystem(gridSizePx);
        this.occupancy = new GridOccupancy();

        Pane gridBackground = gridSystem.generateBackground(this.widthPx, this.heightPx, Color.WHITE, Color.LIGHTGRAY);
        this.layersManager = new SheetLayersManager(gridBackground);

        // POZOR: narozdiel od Board tu nevzniká žiadna počiatočná SchoolBreadboard - plocha je prázdna

        gridBackground.addEventHandler(MouseEvent.MOUSE_CLICKED, event -> {
            if (event.getButton() == MouseButton.PRIMARY && !event.isShiftDown()) clearSelect();
        });

        // označovanie súčiastok a vodičov obdĺžnikom: Shift + stlačenie ľavého tlačidla na
        // voľnej ploche spustí tah, pri ťahu sa kreslí čiarkovaný obdĺžnik a po pustení sa
        // všetky objekty pretínajúce obdĺžnik pridajú k výberu (udržiava sa doterajší výber)
        gridBackground.addEventHandler(MouseEvent.MOUSE_PRESSED, event -> {
            if (event.getButton() != MouseButton.PRIMARY || !event.isShiftDown()) return;
            if (!isEditingEnabled()) return;
            Point2D local = gridBackground.sceneToLocal(event.getSceneX(), event.getSceneY());
            rubberStartX = local.getX();
            rubberStartY = local.getY();
            rubberBand = new Rectangle(0, 0, 0, 0);
            rubberBand.setFill(null);
            rubberBand.setStroke(Color.BLACK);
            rubberBand.getStrokeDashArray().addAll(4.0, 4.0);
            rubberBand.setStrokeWidth(1.5);
            rubberBand.setMouseTransparent(true);
            gridBackground.getChildren().add(rubberBand);
            event.consume();
        });

        gridBackground.addEventHandler(MouseEvent.MOUSE_DRAGGED, event -> {
            if (rubberBand == null) return;
            Point2D local = gridBackground.sceneToLocal(event.getSceneX(), event.getSceneY());
            rubberBand.setLayoutX(Math.min(rubberStartX, local.getX()));
            rubberBand.setLayoutY(Math.min(rubberStartY, local.getY()));
            rubberBand.setWidth(Math.abs(local.getX() - rubberStartX));
            rubberBand.setHeight(Math.abs(local.getY() - rubberStartY));
            event.consume();
        });

        gridBackground.addEventHandler(MouseEvent.MOUSE_RELEASED, event -> {
            if (rubberBand == null) return;
            Rectangle band = rubberBand;
            rubberBand = null;
            gridBackground.getChildren().remove(band);
            if (event.getButton() != MouseButton.PRIMARY || !event.isShiftDown()) return;

            Bounds bandBounds = band.getBoundsInParent();
            for (GateSymbol gate : layersManager.getGates()) {
                if (gate.getBoundsInParent().intersects(bandBounds)) addSelect(gate);
            }
            for (Wire wire : layersManager.getWires()) {
                if (wire.getBoundsInParent().intersects(bandBounds)) addSelect(wire);
            }
            event.consume();
        });

        this.addEventHandler(MouseDragEvent.MOUSE_DRAG_ENTERED, onMouseDragEnteredHandle);
        this.addEventFilter(MouseDragEvent.MOUSE_DRAG_OVER, onMouseDragOverHandle);
        this.addEventFilter(MouseDragEvent.MOUSE_DRAG_RELEASED, onMouseDragReleasedHandle);
        this.addEventHandler(MouseDragEvent.MOUSE_DRAG_EXITED, onMouseDragExitedHandle);

        // ZOOM/PAN
        this.setPannable(false);
        //scrollbar-y sa skryjú: ScrollPane dostáva obsah presne vo veľkosti viewportu, takže
        //skin nemá čo scrollovať ani centrovať - celý posun schémy (pan aj zoom kotva) vedie
        //výhradne cez zoomPane.translateX/Y, ktoré skin nikdy neprepisuje.
        this.setHbarPolicy(ScrollPane.ScrollBarPolicy.NEVER);
        this.setVbarPolicy(ScrollPane.ScrollBarPolicy.NEVER);

        this.contentGroup = this.layersManager.getLayers();
        final StackPane zoomPane = new StackPane(contentGroup);
        //TOP_LEFT - StackPane by default CENTROVAL obsah a centrovacia odchýlka sa so zmenou
        //stupnice menila (polovica zmeny rozmeru obsahu), čo pri vyššom priblížení posúvalo
        //schému doprava dole. Kotva obsahu je teraz pevne v (0,0) zoomPane.
        zoomPane.setAlignment(Pos.TOP_LEFT);
        final Pane scrollContent = new Pane(zoomPane);
        this.setContent(scrollContent);

        this.viewportBoundsProperty().addListener((ChangeListener<Bounds>) (obs, oldV, newV) -> {
            scrollContent.setMinSize(newV.getWidth(), newV.getHeight());
            scrollContent.setPrefSize(newV.getWidth(), newV.getHeight());
            scrollContent.setMaxSize(newV.getWidth(), newV.getHeight());
            zoomPane.setMinSize(newV.getWidth(), newV.getHeight());
        });

        zoomPane.setOnScroll(event -> {
            event.consume();
            if (event.getDeltaY() == 0) return;

            double scaleFactor = (event.getDeltaY() > 0) ? SCALE_DELTA : 1 / SCALE_DELTA;
            double newScale = scaleTotal.doubleValue() * scaleFactor;
            if (newScale < 0.3 || newScale > 3) return;

            //kotva zoomu = bod plochy pod kurzorom (v súradniciach mriežky, pri starej stupnici)
            double mouseSceneX = event.getSceneX();
            double mouseSceneY = event.getSceneY();
            Point2D anchor = contentGroup.sceneToLocal(mouseSceneX, mouseSceneY);

            contentGroup.setScaleX(newScale);
            contentGroup.setScaleY(newScale);
            scaleTotal.setValue(newScale);

            //posun oneskorene (až po najbližšom layout cykle, keď majú scénové transformácie
            //aktuálne rozmery). Kotva sa meria priamo zo scénovej polohy bodu mriežky
            //(contentGroup.localToScene) a presunie sa cez zoomPane.translateX/Y: meraný posun je
            //z definície presný, skin ho nikdy neprepisuje a nezávisí od rozsahu scrollbaru ani
            //od žiadneho centrovania - bod pod kurzorom zostáva fixný pri VŠETKÝCH úrovniach.
            Platform.runLater(() -> {
                scrollContent.applyCss();
                scrollContent.layout();

                Point2D anchorNow = contentGroup.localToScene(anchor);
                //kotva sa presunie o nameranú odchýlku (merané priamo v scéne - presné,
                //nezávislé od rozsahu scrollbaru ani od centrovania skinu)
                zoomPane.setTranslateX(zoomPane.getTranslateX() + (mouseSceneX - anchorNow.getX()));
                zoomPane.setTranslateY(zoomPane.getTranslateY() + (mouseSceneY - anchorNow.getY()));
                //po korekcii sa obsah vráti späť do viewportu (pri najmenších priblíženiach by
                //holá korekcia inak posunula plochu mimo - sivé pásy alebo celé zmiznutie)
                enforceContentInView(zoomPane);
            });
        });

        final javafx.beans.property.ObjectProperty<Point2D> lastMouseCoordinates = new javafx.beans.property.SimpleObjectProperty<>();
        //kotva panu sa zachytáva vo fáze capture (event filter) - aj keď hradlo/vodič v bublinovej
        //fáze MOUSE_PRESSED spotrebuje (otvorenie kontextového menu), kotva má aktuálnu polohu.
        //Pri bublinovom setOnMousePressed by po pravom kliknutí bola kotva zastaraná a následný
        //minimálny ťah by schémy posunul o celú vzdialenosť od staršej polohy.
        scrollContent.addEventFilter(MouseEvent.MOUSE_PRESSED, event -> {
            lastMouseCoordinates.set(new Point2D(event.getX(), event.getY()));
            panAllowed = isOnWireDropSurface(event.getPickResult().getIntersectedNode());
        });

        scrollContent.setOnMouseDragged(event -> {
            //pan sa nepoužíva s pravým tlačidlom - po zobrazení kontextového menu by pohyb myši
            //(ešte so stlačeným tlačidlom) posúval schému a nie výber položky menu
            if (event.getButton() == MouseButton.SECONDARY) return;
            //pan len ak stlačenie začalo na prázdnej ploche; ťah súčiastky/vodiča/spájača/pinu
            //(aj začatie vetvy z vodiča) plochu neposúva
            if (!panAllowed) return;
            //delta proti poslednej polohe (nie proti bodu stlačenia) - inak by sa aplikoval
            //celý ťah od stlačenia pri KAŽDOM drag evente a plocha by utekala a menila smer
            double deltaX = event.getX() - lastMouseCoordinates.get().getX();
            double deltaY = event.getY() - lastMouseCoordinates.get().getY();
            lastMouseCoordinates.set(new Point2D(event.getX(), event.getY()));
            zoomPane.setTranslateX(zoomPane.getTranslateX() + deltaX);
            zoomPane.setTranslateY(zoomPane.getTranslateY() + deltaY);
            enforceContentInView(zoomPane);
        });

        setupWireToWireHandler();

        // kotva pre prilepenie (Ctrl+V) = posledná poloha myši na ploche
        scrollContent.setOnMouseMoved(event -> {
            lastMouseSceneX = event.getSceneX();
            lastMouseSceneY = event.getSceneY();
        });

        // Ctrl+C kopíruje a Ctrl+V vkladá vybraté súčiastky (okno schémy nemá textové polia,
        // takže skratky nijako nekolidujú s úpravou textu)
        this.sceneProperty().addListener((obs, oldScene, newScene) -> {
            if (newScene != null) {
                newScene.getAccelerators().put(
                        new KeyCodeCombination(KeyCode.C, KeyCombination.CONTROL_DOWN), this::copySelection);
                newScene.getAccelerators().put(
                        new KeyCodeCombination(KeyCode.V, KeyCombination.CONTROL_DOWN), this::pasteClipboard);
            }
        });

        this.debugWires.addListener((obs, oldValue, newValue) -> {
            for (Wire wire : layersManager.getWires()) wire.setDebugColored(newValue);
        });
    }

    /**
     * Nastavenie spracovania udalostí pre pripájanie vodičov na iné vodiče.
     * Zachytáva uvoľnenie myši na úrovni scény (capture), aby sa detekovalo, keď užívateľ
     * pustí rozpracovaný vodič (alebo uchopený koniec) na pine/spájači/vodiči.
     * <p>
     * Poradie riešenia pri pustení: pin/súčiastka (vracia sa - dokončia to vlastné
     * handlery) → spájač → voľný koniec iného vodiča → vodič (rozdelenie) →
     * najbližší vodič na prázdnej ploche → nič (zdrojový handler zruší/dokončí).
     */
    private void setupWireToWireHandler() {
        this.sceneProperty().addListener((obs, oldScene, newScene) -> {
            if (newScene == null) return;
            newScene.addEventFilter(MouseEvent.MOUSE_RELEASED, event -> {
                Wire inProgress = Pin.getInProgressWire();
                WireEnd grabbed = WireEnd.getGrabbedEnd();
                if (inProgress == null && grabbed == null) return;

                Wire own = inProgress != null ? inProgress : grabbed.getWire();
                WireEnd freeEnd = inProgress != null ? inProgress.catchFreeEnd() : grabbed;

                Node picked = event.getPickResult() == null ? null : event.getPickResult().getIntersectedNode();

                // pustenie na pin/súčiastku necháme na handlery prvkov (MouseDragEvent sa
                // stará o pripojenie, zdrojový handler o dokončenie/zrušenie ťahu)
                if (findAncestor(picked, Pin.class) != null || findAncestor(picked, GateSymbol.class) != null) {
                    return;
                }

                Point2D sheetXY = sceneToSheet(event.getSceneX(), event.getSceneY());
                GridSystem grid = gridSystem;
                double gridMin = grid.getSizeMin();
                Point2D snapPoint = new Point2D(
                        Math.round(sheetXY.getX() / gridMin) * gridMin,
                        Math.round(sheetXY.getY() / gridMin) * gridMin);

                // 1) spájač (viditeľný, alebo koniec vodiča na spájači)
                WireJunction junctionTarget = findJunctionTarget(picked);
                if (junctionTarget == null) {
                    // neviditeľný zlom myšou nebuchne - hľadá sa geometricky v okolí
                    junctionTarget = WireJunction.findNear(this, sheetXY, gridMin / 2.0);
                }
                if (junctionTarget != null) {
                    if (inProgress != null && junctionTarget == inProgress.getStartJunction()) {
                        // pustenie späť na vlastný počiatočný spájač = zrušenie ťahu
                        Pin.finishInProgressWire();
                        event.consume();
                        return;
                    }
                    if (junctionTarget == freeEnd.getJunction()) {
                        // pustenie na vlastný spájač = nič nerobíme
                        return;
                    }
                    freeEnd.connect(junctionTarget);
                    finishWireDrop(inProgress);
                    event.consume();
                    return;
                }

                // 2) voľný koniec iného vodiča v okolí = spoločný spájač
                WireJunction shared = findFreeEndNear(own, snapPoint, gridMin / 2.0);
                if (shared != null) {
                    freeEnd.connect(shared);
                    finishWireDrop(inProgress);
                    event.consume();
                    return;
                }

                // 3) pustenie priamo na vodič = rozdelenie v mieste pustenia
                Wire targetWire = findAncestor(picked, Wire.class);
                if (targetWire != null) {
                    if (targetWire == own) {
                        // pustenie na vlastný vodič = ukončenie bez pripojenia
                        Pin.finishInProgressWire();
                        WireEnd.finishGrab();
                        return;
                    }
                    WireJunction junction = targetWire.splitAtPoint(sheetXY);
                    if (junction != null) {
                        freeEnd.connect(junction);
                        finishWireDrop(inProgress);
                        event.consume();
                        return;
                    }
                }

                // 4) pustenie na prázdnej ploche v okolí neďalekého vodiča
                if (isOnWireDropSurface(picked)) {
                    Wire nearest = findNearestWire(own, sheetXY);
                    if (nearest != null) {
                        WireJunction junction = nearest.splitAtPoint(sheetXY);
                        if (junction != null) {
                            freeEnd.connect(junction);
                            finishWireDrop(inProgress);
                            event.consume();
                            return;
                        }
                    }
                }
                // nič - zdrojový handler ťah dokončí alebo zruší
            });
        });
    }

    private static <T extends Node> T findAncestor(Node node, Class<T> type) {
        Node current = node;
        while (current != null) {
            if (type.isInstance(current)) return type.cast(current);
            current = current.getParent();
        }
        return null;
    }

    private WireJunction findJunctionTarget(Node picked) {
        Node target = picked;
        while (target != null) {
            if (target instanceof WireJunction) {
                WireJunction junction = (WireJunction) target;
                if (!junction.isRemoved()) return junction;
                return null;
            }
            if (target instanceof WireEnd) {
                WireJunction junction = ((WireEnd) target).getJunction();
                if (junction != null) return junction;
            }
            if (target instanceof Pin || target instanceof Wire) return null;
            target = target.getParent();
        }
        return null;
    }

    /**
     * Hľadá voľný koniec iného vodiča v okolí bodu; ak sa nájde, vytvorí v bode
     * spoločný spájač a pripojí naň oba voľné konce (dva vodiče sa tak stretnú
     * v jednom bode bez zbytočného rozdelenia).
     */
    private WireJunction findFreeEndNear(Wire exclude, Point2D point, double tolerance) {
        for (Wire wire : layersManager.getWires()) {
            if (wire == exclude || wire.isPreview()) continue;
            for (WireEnd end : wire.getEnds()) {
                if (end.isConnected()) continue;
                if (end.getConnectionPoint().distance(point) <= tolerance) {
                    WireJunction junction = WireJunction.at(this, point.getX(), point.getY());
                    end.connect(junction);
                    return junction;
                }
            }
        }
        return null;
    }

    /**
     * Najbližší vodič (okrem {@code exclude}) k bodu - pre pustenie konca vodiča
     * v okolí na prázdnej ploche. Tolerancia je {@link #WIRE_DROP_TOLERANCE} (5 px),
     * rovnaká ako pri pinoch a spájačoch.
     */
    private Wire findNearestWire(Wire exclude, Point2D sheetXY) {
        double tolerance = WIRE_DROP_TOLERANCE;

        Wire bestWire = null;
        double bestDist = Double.MAX_VALUE;
        for (Wire wire : layersManager.getWires()) {
            if (wire == exclude) continue;
            double dist = wire.distanceToPoint(sheetXY);
            if (dist < bestDist) {
                bestDist = dist;
                bestWire = wire;
            }
        }
        if (bestWire == null || bestDist > tolerance) return null;
        return bestWire;
    }

    private void finishWireDrop(Wire inProgress) {
        if (inProgress != null) {
            Pin.finishInProgressWire();
        } else {
            WireEnd.finishGrab();
        }
    }

    /**
     * Či bol pick na prázdnej ploche schémy (pozadie) - len vtedy môže byť pustenie
     * konca vodiča v okolí interpretované ako pripojenie na neďaleký vodič. Spustenie
     * na pine, súčiastke, spájači či vodiči nesmie fallback zachytiť - tam majú
     * prednosť vlastné handlery (pripojenie na pin, menu zbernice atď.).
     */
    private boolean isOnWireDropSurface(Node picked) {
        Node node = picked;
        while (node != null) {
            if (node instanceof Pin || node instanceof Joint || node instanceof GateSymbol || node instanceof Wire) {
                return false;
            }
            if (node == layersManager.getLayer("background")) return true;
            node = node.getParent();
        }
        return false;
    }

    /**
     * Po korekcii zoomu/panu obsah neskĺzne mimo viewport: poloha počiatku obsahu
     * (meraná priamo zo scény - contentGroup.localToScene(0,0)) sa priclampe do rozsahu
     * {@code [-(obsah-viewport), 0]}, takže plocha viewport vždy zakrýva. Ak je obsah menší
     * ako viewport, ukotví sa vľavo hore. Ak korekcia dokáže byť v rozsahu bez posunu,
     * nič sa nemení - kotva pod kurzorom tak zostáva exaktná a na okrajoch (najmä pri
     * najmenších priblíženiach) sa plocha nevymkne mimo.
     */
    private void enforceContentInView(StackPane zoomPane) {
        double cw = contentGroup.getLayoutBounds().getWidth() * scaleTotal.doubleValue();
        double ch = contentGroup.getLayoutBounds().getHeight() * scaleTotal.doubleValue();
        Bounds vp = this.localToScene(this.getViewportBounds());
        Point2D o = contentGroup.localToScene(0, 0);

        double excessX = cw - vp.getWidth();
        double oRelX = o.getX() - vp.getMinX();
        double targetRelX = oRelX;
        if (excessX < 0) {
            targetRelX = 0;
        } else if (oRelX > 0) {
            targetRelX = 0;
        } else if (oRelX < -excessX) {
            targetRelX = -excessX;
        }

        double excessY = ch - vp.getHeight();
        double oRelY = o.getY() - vp.getMinY();
        double targetRelY = oRelY;
        if (excessY < 0) {
            targetRelY = 0;
        } else if (oRelY > 0) {
            targetRelY = 0;
        } else if (oRelY < -excessY) {
            targetRelY = -excessY;
        }

        zoomPane.setTranslateX(zoomPane.getTranslateX() + (targetRelX - oRelX));
        zoomPane.setTranslateY(zoomPane.getTranslateY() + (targetRelY - oRelY));
    }

    public double getAppliedScale() {
        return scaleTotal.getValue();
    }

    public SimpleDoubleProperty zoomScaleProperty() {
        return scaleTotal;
    }

    public boolean hasChanged() {
        return hasChanged;
    }

    /**
     * Označí schému ako zmenenú (úspešná zmena uskutočnená priamo na súčiastke,
     * napr. zmena dĺžky zbernice).
     */
    public void markChanged() {
        hasChanged = true;
    }

    public void clearChange() {
        this.hasChanged = false;
    }

    /**
     * Pevná veľkosť bunky pre kreslenie súčiastok v pixeloch. Mriežka plochy (čiary aj
     * snap vodičov a súčiastok) môže byť jemnejšia, súčiastky si však držia pôvodnú
     * veľkosť tela aj rozostup pinov.
     */
    public static final int COMPONENT_CELL = 20;

    public int getComponentCell() {
        return COMPONENT_CELL;
    }

    public GridSystem getGrid() {
        return gridSystem;
    }

    /**
     * Vrstva spájačov (WireJunction) - na vrchu všetkých vrstiev, aby boli čierne body
     * vždy viditeľné a uchopiteľné myšou aj cez neskôr pridané vodiče.
     */
    public Pane getJunctionsLayer() {
        return layersManager.getJunctionsLayer();
    }

    public GridOccupancy getOccupancy() {
        return occupancy;
    }

    public double getWidthPx() {
        return widthPx;
    }

    public double getHeightPx() {
        return heightPx;
    }

    /**
     * Prepočet zo scénových súradníc na súradnice plochy (nahrádza pôvodné Board.sceneToBoard).
     */
    public Point2D sceneToSheet(double sceneX, double sceneY) {
        return layersManager.getLayer("background").sceneToLocal(sceneX, sceneY);
    }

    public double getOriginSceneOffsetX() {
        return layersManager.getLayer("background").getLocalToSceneTransform().getTx();
    }

    public double getOriginSceneOffsetY() {
        return layersManager.getLayer("background").getLocalToSceneTransform().getTy();
    }

    public boolean addSelect(Selectable item) {
        if (!selected.contains(item)) {
            item.select();
            return selected.add(item);
        }
        return false;
    }

    public boolean removeSelect(Selectable item) {
        item.deselect();
        return selected.remove(item);
    }

    public void clearSelect() {
        selected.forEach(Selectable::deselect);
        selected.clear();
    }

    public void deleteSelect() {
        if (!isEditingEnabled()) return;
        new ArrayList<>(selected).forEach(Selectable::delete);
        // zmazané objekty sa odstránia aj z výberu - vrátane tých, ktoré sa zmazali ako
        // vedľajší efekt (vodiče na pinoch mazanej súčiastky). Inak by ostali v zozname
        // výberu, pri ďalšom označení (najmä gumičkou/Shift+) by sa skopírovali a Ctrl+V
        // by "vzkriesil" už vymazané súčiastky.
        selected.removeIf(item -> !(item instanceof Node) || ((Node) item).getParent() == null);
    }

    public List<Wire> getSelectedWires() {
        List<Wire> result = new ArrayList<>();
        for (Selectable selectable : selected) {
            if (selectable instanceof Wire) result.add((Wire) selectable);
        }
        return result;
    }

    public List<GateSymbol> getSelectedGates() {
        List<GateSymbol> result = new ArrayList<>();
        for (Selectable selectable : selected) {
            if (selectable instanceof GateSymbol) result.add((GateSymbol) selectable);
        }
        return result;
    }

    /**
     * Kopírovanie vybratých súčiastok a vodičov do schránky (Ctrl+C). Ukladá sa snímok typu,
     * vlastností a vzájomných gridových offsetov súčiastok - prilepenie (Ctrl+V) ich vloží
     * rovnako rozložené, len posunuté na miesto pod kurzorom.
     * <p>
     * Kopírujú sa LEN označené vodiče, ale so všetkými typmi koncov - nielen keď sú obidva
     * na pine súčiastky, ale aj keď končia na spájači ({@link WireJunction}). Po založení
     * odbočky sa totiž kmeňový vodič rozdelí na niekoľko samostatných vodičov končiacich
     * na spájači a takéto vodiče by sa inak vyhodili - pri prilepení by potom chýbali celé
     * odbočky aj kmeň medzi nimi.
     * <p>
     * Vyberá sa uzáver nad spájačmi: doplnia sa vodiče, na ktorých spájačoch vybrané
     * vodiče končia (spájač musí mať po prilepení hostiteľa) aj susedné vodiče patriace
     * do kopírovanej skupiny súčiastok. Vodiče s pinmi mimo kopírovanej skupiny alebo
     * také, ktoré by po prilepení ostali zavesené na spájači bez protistrany, sa odhodia.
     */
    public void copySelection() {
        if (!isEditingEnabled()) return;
        List<GateSymbol> gates = getSelectedGates();
        List<Wire> selectedWires = new ArrayList<>();
        for (Selectable selectable : selected) {
            if (selectable instanceof Wire) selectedWires.add((Wire) selectable);
        }
        // schránka sa pri KAŽDOM Ctrl+C vymaže - vloží sa len to, čo sa kopíruje teraz,
        // nie starý obsah z predchádzajúceho kopírovania
        clipboardGates = new ArrayList<>();
        clipboardWires = new ArrayList<>();
        // bez označených súčiastok nemajú vodiče ku kopírovaným pinnom čo pripojiť
        if (gates.isEmpty()) return;

        int minX = Integer.MAX_VALUE;
        int minY = Integer.MAX_VALUE;
        for (GateSymbol gate : gates) {
            minX = Math.min(minX, gate.getGridPosX());
            minY = Math.min(minY, gate.getGridPosY());
        }
        clipboardBaseX = minX;
        clipboardBaseY = minY;
        for (GateSymbol gate : gates) {
            // názov inštancie sa nekopíruje - pri vložení dostane klon nové najmenšie voľné číslo
            Map<String, String> properties = new LinkedHashMap<>(gate.saveProperties());
            properties.remove("name");
            clipboardGates.add(new CopiedGate(gate, properties,
                    gate.getGridPosX() - minX, gate.getGridPosY() - minY));
        }

        for (Wire wire : collectCopyableWires(selectedWires)) {
            clipboardWires.add(new CopiedWire(wire.getColor(),
                    new CopiedEnd[]{copyEnd(wire.getEnds()[0]), copyEnd(wire.getEnds()[1])}));
        }
    }

    /** Popis jedného konca kopírovaného vodiča pre schránku. */
    private CopiedEnd copyEnd(WireEnd end) {
        Pin pin = end.getPin();
        if (pin != null) {
            GateSymbol owner = pin.getOwner();
            return new CopiedEnd(owner, owner.getPins().indexOf(pin), false,
                    new Point2D(end.getLayoutX(), end.getLayoutY()));
        }
        WireJunction junction = end.getJunction();
        if (junction != null) {
            return new CopiedEnd(null, -1, true,
                    new Point2D(junction.getLayoutX(), junction.getLayoutY()));
        }
        return new CopiedEnd(null, -1, false,
                new Point2D(end.getLayoutX(), end.getLayoutY()));
    }

    /**
     * Či možno vodič kopírovať: nemá voľný (nedokončený) koniec a všetky jeho piny sú
     * na práve kopírovaných súčiastkach. Spájače na koncoch vodiča nevadia - tie sa
     * obnovia spoločne so spolu-susednými vodičmi na rovnakom bode.
     */
    private boolean isWireCopyable(Wire wire, Set<GateSymbol> copiedGates) {
        for (WireEnd end : wire.getEnds()) {
            Pin pin = end.getPin();
            if (pin != null) {
                if (!copiedGates.contains(pin.getOwner())) return false;
            } else if (end.getJunction() == null) {
                return false;
            }
        }
        return true;
    }

    /**
     * Vodiče, ktoré sa majú skopírovať - uzáver označených vodičov cez spájače.
     * <p>
     * Postup: zo začiatku sa vezmú označené vodiče spĺňajúce {@link #isWireCopyable}.
     * Potom sa v uzávere opakovane: doplnia sa vodiče dotýkajúce sa spájačov už vybraných
     * vodičov (susedia z rovnakej skupiny nesmú chýbať, inak by po prilepení chýbala
     * odbočka) a odhodia sa vodiče, na ktorých by po prilepení ostal osamotený jediný
     * koniec. Raz odhodený vodič sa už znova nepridá, takže cyklus je vždy konečný.
     */
    private List<Wire> collectCopyableWires(List<Wire> selectedWires) {
        Set<GateSymbol> copiedGates = new HashSet<>();
        for (CopiedGate copied : clipboardGates) copiedGates.add(copied.source);

        List<Wire> result = new ArrayList<>();
        for (Wire wire : selectedWires) {
            if (wire.getParent() != null && isWireCopyable(wire, copiedGates)) {
                result.add(wire);
            }
        }

        Set<Wire> dropped = new HashSet<>();
        boolean changed = true;
        while (changed) {
            changed = false;

            // doplnenie: hostiteľ spájača musí byť kopírovaný tiež (spájač na ňom žije)
            // a susedné vodiče na spájači patriace do tej istej skupiny súčiastok
            List<Wire> add = new ArrayList<>();
            for (Wire wire : result) {
                for (WireEnd end : wire.getEnds()) {
                    WireJunction junction = end.getJunction();
                    if (junction == null) continue;
                    for (Wire neighbour : junction.getConnectedWires()) {
                        if (!result.contains(neighbour) && !dropped.contains(neighbour)
                                && !add.contains(neighbour) && isWireCopyable(neighbour, copiedGates)) {
                            add.add(neighbour);
                        }
                    }
                }
            }
            if (!add.isEmpty()) {
                result.addAll(add);
                changed = true;
            }

            // odhodenie: spájač, na ktorom by po prilepení zostal osamotený jediný koniec
            // (druhý vodič vedie mimo skupiny) - vodič by inak visel na spájači bez protistrany
            List<Wire> remove = new ArrayList<>();
            for (WireJunction junction : junctionsOf(result)) {
                List<Wire> atJunction = junction.getConnectedWires();
                Wire lone = null;
                int inside = 0;
                for (Wire wire : atJunction) {
                    if (result.contains(wire)) {
                        inside++;
                        lone = wire;
                    }
                }
                if (atJunction.size() >= 2 && inside == 1 && !remove.contains(lone)) {
                    remove.add(lone);
                }
            }

            if (!remove.isEmpty()) {
                result.removeAll(remove);
                dropped.addAll(remove);
                changed = true;
            }
        }
        return result;
    }

    /** Spájače, na ktorých končia vodiče z danej množiny. */
    private static List<WireJunction> junctionsOf(List<Wire> wires) {
        List<WireJunction> junctions = new ArrayList<>();
        for (Wire wire : wires) {
            for (WireEnd end : wire.getEnds()) {
                WireJunction junction = end.getJunction();
                if (junction != null && !junctions.contains(junction)) junctions.add(junction);
            }
        }
        return junctions;
    }

    /**
     * Prilepenie súčiastok zo schránky (Ctrl+V) na poslednú pozíciu myši na mriežke.
     * Nové súčiastky sa po prilepení označia (výber sa presunie na ne), vodiče sa
     * pripoja na zodpovedajúce piny klonov.
     * <p>
     * Konce vodičov na spájačoch sa riešia v druhom prechode: spájač sa zdieľa podľa
     * polohy, takže všetky konce v tom istom bode dostanú jeden spoločný objekt -
     * rovnako ako pri načítaní súboru ({@link SchemeLoader}). Spájač sa vytvorí na už
     * prilepenom vodiči prechádzajúcim daným bodom, prípadne ako samostatný na vodiči
     * prvého konca, ktorý naň natrafí.
     */
    public void pasteClipboard() {
        if (!isEditingEnabled()) return;
        if (clipboardGates.isEmpty() && clipboardWires.isEmpty()) return;

        Point2D mouseOnGrid = lastMouseToGrid();
        int targetX = (int) Math.round(mouseOnGrid.getX());
        int targetY = (int) Math.round(mouseOnGrid.getY());

        Map<GateSymbol, GateSymbol> cloneBySource = new HashMap<>();
        clearSelect();
        for (CopiedGate copied : clipboardGates) {
            int gridX = targetX + copied.relX;
            int gridY = targetY + copied.relY;

            GateSymbol clone;
            try {
                clone = copied.type.getConstructor(SchematicSheet.class).newInstance(this);
            } catch (InstantiationException | IllegalAccessException
                    | InvocationTargetException | NoSuchMethodException e) {
                e.printStackTrace();
                continue;
            }

            addItem(clone);
            clone.moveTo(gridX, gridY);
            clone.loadProperties(copied.properties);
            occupancy.occupy(clone);
            addSelect(clone);
            cloneBySource.put(copied.source, clone);
        }

        double deltaPx = (targetX - clipboardBaseX) * gridSystem.getSizeX();
        double deltaPy = (targetY - clipboardBaseY) * gridSystem.getSizeY();

        Map<Long, WireJunction> hubByKey = new HashMap<>();
        List<Wire> pastedWires = new ArrayList<>();
        List<JunctionEnd> pendingEnds = new ArrayList<>();

        for (CopiedWire copied : clipboardWires) {
            // konce na pine sa musia dať vyriešiť na klony - inak sa vodič neprilepí
            Pin[] pins = new Pin[2];
            boolean resolvable = true;
            for (int i = 0; i < 2; i++) {
                if (copied.ends[i].gate == null) continue;
                pins[i] = clonePin(copied.ends[i], cloneBySource);
                if (pins[i] == null) {
                    resolvable = false;
                    break;
                }
            }
            if (!resolvable) continue;

            Wire wire = new Wire(this);
            addItem(wire);
            wire.changeColor(copied.color);
            pastedWires.add(wire);

            WireEnd[] ends = wire.getEnds();
            for (int i = 0; i < 2; i++) {
                CopiedEnd source = copied.ends[i];
                if (source.gate != null) {
                    ends[i].connect(pins[i]);
                } else {
                    // spájač/voľný koniec sa najprv umiestni na budúcu pozíciu, aby mali
                    // zlomky správnu trasu; na spájač sa pripojí až v druhom prechode
                    double x = source.position.getX() + deltaPx;
                    double y = source.position.getY() + deltaPy;
                    ends[i].moveTo(x, y);
                    if (source.junction) pendingEnds.add(new JunctionEnd(ends[i], x, y));
                }
            }
        }

        // druhý prechod: konce, ktoré končia na spájači - najprv sa hľadá už vytvorený
        // spájač v rovnakom bode, inak sa založí na prilepenom vodiči prechádzajúcim
        // bodom (legacy) alebo ako samostatný na vodiči tohto konca
        for (JunctionEnd pending : pendingEnds) {
            resolveJunctionEnd(pending, pastedWires, hubByKey);
        }

        // dokončené vodiče sa usadia na mriežku - počas skladania mohli byť segmenty
        // prepočítané skôr, než bol vodič celý zapojený (nesnapovaná trasa)
        for (Wire wire : pastedWires) {
            wire.settleToGrid();
        }
    }

    /**
     * Pripojenie konca vodiča na spájač v danej pozícii. Spájače sa zdieľajú cez
     * {@code hubByKey} (kľúč = poloha), takže všetky konce v tom istom bode dostanú
     * jeden objekt. Ak vodič prilepený v tomto bode prechádza, rozdelí sa; inak sa
     * založí samostatný spájač. Logika zodpovedá {@link SchemeLoader} pri načítaní.
     */
    private void resolveJunctionEnd(JunctionEnd pending, List<Wire> pastedWires,
                                    Map<Long, WireJunction> hubByKey) {
        long key = junctionKey(pending.x, pending.y);
        Point2D position = new Point2D(pending.x, pending.y);

        WireJunction shared = hubByKey.get(key);
        if (shared != null && !shared.isRemoved()) {
            pending.end.connect(shared);
            return;
        }

        // existujúci spájač presne v bode (založený iným koncom tohto prilepenia)
        for (Wire wire : pastedWires) {
            if (wire == pending.end.getWire()) continue;
            for (WireEnd end : wire.getEnds()) {
                WireJunction existing = end.getJunction();
                if (existing != null && junctionKey(existing.getLayoutX(), existing.getLayoutY()) == key) {
                    hubByKey.put(key, existing);
                    pending.end.connect(existing);
                    return;
                }
            }
        }

        // vodič prilepený v tomto bode prechádza - spájač sa založí rozdelením
        double grid = gridSystem.getSizeMin();
        for (Wire wire : pastedWires) {
            if (wire == pending.end.getWire()) continue;
            if (wire.distanceToPoint(position) <= grid / 2.0) {
                WireJunction created = wire.splitAtPoint(position);
                if (created != null) {
                    hubByKey.put(key, created);
                    pending.end.connect(created);
                    return;
                }
            }
        }

        // samostatný spájač (kmeň končí priamo na spájači)
        WireJunction standalone = WireJunction.at(this, pending.x, pending.y);
        hubByKey.put(key, standalone);
        pending.end.connect(standalone);
    }

    /** Kľúč polohy spájača pre zdieľanie medzi koncami rôznych vodičov. */
    private static long junctionKey(double x, double y) {
        return Math.round(x) * 1000003L + Math.round(y);
    }

    /** Pin na klone súčiastky podľa popisu konca (null, ak sa klon nepodarilo vytvoriť). */
    private Pin clonePin(CopiedEnd source, Map<GateSymbol, GateSymbol> cloneBySource) {
        GateSymbol clone = cloneBySource.get(source.gate);
        if (clone == null) return null;
        if (source.pinIndex < 0 || source.pinIndex >= clone.getPins().size()) return null;
        return clone.getPins().get(source.pinIndex);
    }

    /** Súradnice poslednej polohy myši prepočítané na mriežku (pri neznámej polohe 2,2). */
    private Point2D lastMouseToGrid() {
        if (lastMouseSceneX < 0 || lastMouseSceneY < 0) {
            return new Point2D(2, 2);
        }
        Point2D local = layersManager.getLayer("background")
                .sceneToLocal(lastMouseSceneX, lastMouseSceneY);
        return gridSystem.pixelToGrid(local.getX(), local.getY());
    }

    public boolean addItem(Object item) {
        hasChanged = true;
        if (item instanceof GateSymbol) {
            GateSymbol gate = (GateSymbol) item;
            String prefix = gate.getInstanceNamePrefix();
            if (prefix != null && gate.getInstanceName() == null) {
                gate.setInstanceName(nextComponentName(prefix));
            }
        }
        if (item instanceof Wire) {
            ((Wire) item).setDebugColored(this.debugWires.get());
        }
        return layersManager.add(item);
    }

    /**
     * Najmenšie nepoužité číslo pre daný prefix názvu medzi súčiastkami na ploche
     * (napr. pre {@code REG} vráti {@code REG3}, ak sú použité {@code REG1} a {@code REG2}).
     */
    private String nextComponentName(String prefix) {
        Set<Integer> used = new HashSet<>();
        for (GateSymbol gate : getGates()) {
            String name = gate.getInstanceName();
            if (name != null && name.startsWith(prefix)) {
                String suffix = name.substring(prefix.length());
                if (suffix.matches("\\d+")) used.add(Integer.parseInt(suffix));
            }
        }
        int index = 1;
        while (used.contains(index)) index++;
        return prefix + index;
    }

    public boolean removeItem(Object item) {
        hasChanged = true;
        if (item instanceof GateSymbol) occupancy.free((GateSymbol) item);
        return layersManager.remove(item);
    }

    public void clearSheet() {
        this.layersManager.clear();
        this.occupancy.clear();
    }

    /**
     * Zapnutie simulácie. Nahrádza pôvodné Board.powerOn - namiesto zberu PowerSocket-ov
     * (abstraktné hradlá nemajú napájanie) sa jednoducho odovzdajú všetky súčiastky na ploche.
     */
    public void powerOn() {
        if (!simulator.runningProperty().getValue()) {
            simulator.start(layersManager.getGates());
        }
    }

    public void powerOff() {
        simulator.stop();
    }

    public boolean isSimulationRunning() {
        return simRunningProperty().getValue();
    }

    public boolean isEditingEnabled() {
        return editingEnabled.get();
    }

    public void setEditingEnabled(boolean enabled) {
        editingEnabled.set(enabled);
    }

    public ReadOnlyBooleanProperty editingEnabledProperty() {
        return editingEnabled;
    }

    public ReadOnlyBooleanProperty simRunningProperty() {
        return simulator.runningProperty();
    }

    public SchematicSimulator getSimulator() {
        return simulator;
    }

    /**
     * Všetky súčiastky aktuálne umiestnené na ploche.
     */
    public List<GateSymbol> getGates() {
        return layersManager.getGates();
    }

    /**
     * Všetky vodiče aktuálne na ploche.
     */
    public List<Wire> getWires() {
        return layersManager.getWires();
    }

    public void addEvent(SheetEvent event) {
        simulator.addEvent(event);
    }

    public boolean isDebugWires() {
        return debugWires.get();
    }

    public void setDebugWires(boolean debug) {
        debugWires.set(debug);
    }

    public BooleanProperty debugWiresProperty() {
        return debugWires;
    }

    public Point2D getMousePositionOnGrid(MouseEvent event) {
        Point2D local = layersManager.getLayer("background").sceneToLocal(event.getSceneX(), event.getSceneY());
        return gridSystem.pixelToGrid(local.getX(), local.getY());
    }

    /**
     * Snímka jednej kopírovanej súčiastky - referencie na originál (pre mapovanie pinov
     * vodičov), vlastnosti (pre obnovu cez loadProperties) a gridový offset voči ľavému
     * hornému rohu celej skupiny vybraných súčiastok.
     */
    private static final class CopiedGate {
        final GateSymbol source;
        final Class<? extends GateSymbol> type;
        final Map<String, String> properties;
        final int relX;
        final int relY;

        CopiedGate(GateSymbol source, Map<String, String> properties, int relX, int relY) {
            this.source = source;
            this.type = source.getClass();
            this.properties = properties;
            this.relX = relX;
            this.relY = relY;
        }
    }

    /**
     * Popis konca kopírovaného vodiča: buď pin (súčiastka + index pinu), alebo spájač
     * či voľný koniec so svojou polohou v layoutových súradniciach plochy.
     */
    private static final class CopiedEnd {
        /** Vlastník pinu, alebo null ak koniec nie je na pine. */
        final GateSymbol gate;
        final int pinIndex;
        /** Koniec je napojený na spájač (WireJunction) v bode {@link #position}. */
        final boolean junction;
        /** Poloha konca/spájača v layoutových súradniciach plochy. */
        final Point2D position;

        CopiedEnd(GateSymbol gate, int pinIndex, boolean junction, Point2D position) {
            this.gate = gate;
            this.pinIndex = pinIndex;
            this.junction = junction;
            this.position = position;
        }
    }

    /**
     * Snímka jedného kopírovaného vodiča - farba a oba konce (popis vyššie).
     * Všetky súradnice sú v layoutových súradniciach plochy a pri prilepení sa
     * posunú o rovnaký delta ako súčiastky. Vodič je vždy priamy úsečný, takže
     * jeho tvar sa obnoví z koncov - netreba ukladať zlomy.
     */
    private static final class CopiedWire {
        final Color color;
        final CopiedEnd[] ends;

        CopiedWire(Color color, CopiedEnd[] ends) {
            this.color = color;
            this.ends = ends;
        }
    }

    /**
     * Koniec vodiča čakajúci v druhom prechode prilepenia na pripojenie k spájaču
     * v bode (x, y) - spájač ešte nemusel existovať, lebo jeho hostiteľ sa lepil neskôr.
     */
    private static final class JunctionEnd {
        final WireEnd end;
        final double x;
        final double y;

        JunctionEnd(WireEnd end, double x, double y) {
            this.end = end;
            this.x = x;
            this.y = y;
        }
    }
}
