package sk.uniza.fri.cp.App.CPUControl;

import javafx.animation.Animation;
import javafx.animation.Transition;
import javafx.application.Platform;
import javafx.beans.property.Property;
import javafx.beans.property.SimpleBooleanProperty;
import javafx.beans.property.SimpleIntegerProperty;
import javafx.beans.property.SimpleStringProperty;
import javafx.beans.value.ChangeListener;
import javafx.beans.value.ObservableValue;
import javafx.collections.FXCollections;
import javafx.collections.ObservableList;
import javafx.collections.ObservableSet;
import javafx.concurrent.Service;
import javafx.concurrent.Task;
import javafx.concurrent.WorkerStateEvent;
import javafx.css.PseudoClass;
import javafx.event.EventHandler;
import javafx.fxml.FXML;
import javafx.fxml.Initializable;
import javafx.scene.control.*;
import javafx.scene.control.cell.PropertyValueFactory;
import javafx.scene.input.KeyCode;
import javafx.scene.input.KeyCodeCombination;
import javafx.scene.input.KeyCombination;
import javafx.scene.input.KeyEvent;
import javafx.scene.layout.AnchorPane;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.HBox;
import javafx.scene.layout.StackPane;
import javafx.stage.FileChooser;
import javafx.stage.Stage;
import javafx.util.Duration;
import org.controlsfx.control.Notifications;
import org.controlsfx.control.ToggleSwitch;
import org.fxmisc.flowless.VirtualizedScrollPane;
import org.fxmisc.richtext.CodeArea;
import org.fxmisc.richtext.InlineCssTextArea;
import sk.uniza.fri.cp.App.AboutDialog;
import sk.uniza.fri.cp.App.CPUControl.CodeEditor.CodeEditorFactory;
import sk.uniza.fri.cp.App.CPUControl.CodeEditor.RichTextFXHelpers;
import sk.uniza.fri.cp.App.CPUControl.io.ConsoleOutputStream;
import sk.uniza.fri.cp.App.SchematicControl.SchematicController;
import sk.uniza.fri.cp.Bus.Bus;
import sk.uniza.fri.cp.CPUEmul.CPU;
import sk.uniza.fri.cp.CPUEmul.CPUStates;
import sk.uniza.fri.cp.CPUEmul.Exceptions.InvalidCodeLinesException;
import sk.uniza.fri.cp.CPUEmul.Parser;
import sk.uniza.fri.cp.CPUEmul.Program;
import sk.uniza.fri.cp.SchematicSim.Sheet.SchematicSheet;

import javax.swing.*;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.util.Optional;
import java.util.ResourceBundle;
import java.util.TreeSet;
import java.util.concurrent.CountDownLatch;
import java.util.function.Consumer;

import static sk.uniza.fri.cp.App.App.primStage;
import static sk.uniza.fri.cp.App.CPUControl.DataRepresentation.eRepresentation;
import static sk.uniza.fri.cp.App.CPUControl.DataRepresentation.getDisplayRepresentation;

//CodeArea zvyraznovanie slov


/**
 * Controller pre okno CPUEmul-átora.
 *
 * @author Tomáš Hianik
 * @version 1.0
 * @created 07-feb-2017 18:40:27
 */
public class CPUController implements Initializable {

    //uchovanie aktualneho zobrazenia registrov a pamati
	private eRepresentation displayFormRegisters;
	private eRepresentation displayFormStackAddr;
	private eRepresentation displayFormStackData;
	private eRepresentation displayFormProgMemoryAddr;
	private eRepresentation displayFormProgMemoryData;
    private eRepresentation displayFormRAMAddr;
    private eRepresentation displayFormRAMData;

    private CPU cpu; //instancia CPU
    private ConsoleOutputStream cos_cpu; //vystup na konzolu pre CPU
    volatile private Program program; //parsovany program ktoreho kod je aktualne v editore
    volatile private boolean f_intBylevel;
    volatile private boolean f_microstep;
    volatile private boolean f_startPaused; //pri krokovani pred spustenim sa spusta CPU s pauzou
    volatile private SimpleBooleanProperty f_paused;    //indikator, ci je prebiehajuci program pozastaveny
    volatile private SimpleBooleanProperty f_in_execution; //indikator, ci sa program vykonava
    private SimpleIntegerProperty execution_line;
    private boolean f_logEnabled = false;

    //Breakpointy
    private TreeSet<Integer> breakpointLines;
    private ObservableSet<Integer> observableBreakpointLines;

    @FXML private BorderPane rootPane;

    //Menu
    //Nastavenia
    @FXML private CheckMenuItem chmiSettingsINTLevel;
    @FXML private CheckMenuItem chmiSettingsINTChange;
    @FXML private CheckMenuItem chmiSettingsMicrostep;

    //Editor kodu
    @FXML private TitledPane titPaneCode;
    @FXML private StackPane codeAreaPane;
    @FXML private Button btnLoadCode;
    @FXML private Button btnSaveCode;
    private static final String STYLE_PARAGRAPH_ERROR = "paragraph-error";
    private static final String CODE_PANE_TEXT = "Kód";
    private CodeArea codeEditor;
    private File currentFile;
    private boolean fileSaved;  // true ak je aktualny subor bezpecne ulozeny
    private int fontSize=9;     // velkost fontu - da sa menit

    //konzola
    @FXML private StackPane consolePane;
    private InlineCssTextArea console;

	//vyber zobrazenia registrov / pamati
	@FXML private ToggleGroup btnGroupRegisters;
	@FXML private ToggleGroup btnGroupStackAddr;    //zasobnik
	@FXML private ToggleGroup btnGroupStackData;
	@FXML private ToggleGroup btnGroupProgMemoryAddr;   //konstanty v programe
	@FXML private ToggleGroup btnGroupProgMemoryData;
    @FXML private ToggleGroup btnGroupRAMAddr;  //vnutorna RAM pamat
    @FXML private ToggleGroup btnGroupRAMData;

	//tlacidla
    @FXML
    private HBox toolBox;
    @FXML private Button btnParse;
	@FXML private Button btnStart;
	@FXML private Button btnStep;
	@FXML private Button btnPause;
	@FXML private Button btnReset;
	@FXML private Button btnStop;
    private static final String BTN_TXT_START = "Spusti [F5]";
    private static final String BTN_TXT_CONTINUE = "Pokračuj [F5]";

    @FXML
    private Button btnSimulator;
    private Stage schematicStage;
    private SchematicSheet schematicSheet;
    private SchematicController schematicController;

	//registre
	@FXML private TextField tfRegA;
	@FXML private TextField tfRegB;
	@FXML private TextField tfRegC;
	@FXML private TextField tfRegD;
	@FXML private TextField tfRegPC;
	@FXML private TextField tfRegSP;
	@FXML private TextField tfRegMP;
	@FXML private TextField tfFlagCY;
	@FXML private TextField tfFlagZ;
	@FXML private TextField tfFlagIE;

	//tabulky
    private final PseudoClass pcDataChanged = PseudoClass.getPseudoClass("data-changed");
    //--zasobnik
    @FXML private TableView<StackTableCell> tableViewStack;
    @FXML private TableColumn<StackTableCell, Integer> tableColumnStackAddr;
    @FXML private TableColumn<StackTableCell, Integer> tableColumnStackData;
    private ObservableList<StackTableCell> tableViewStackItems; //List, v ktorom su ulozene itemy tabulky
    private final PseudoClass pcStackHead = PseudoClass.getPseudoClass("stack-head");
    //--konstanty - pamat programu
    @FXML private TableView<MemoryTableCell> tableViewProgMemory;
    @FXML private TableColumn<MemoryTableCell, Integer> tableColumnProgMemoryAddr;
    @FXML private TableColumn<MemoryTableCell, Integer> tableColumnProgMemoryData;
    private ObservableList<MemoryTableCell> tableViewProgMemoryItems; //List, v ktorom su ulozene itemy tabulky
    //--RAM
    @FXML private TableView<MemoryTableCell> tableViewRAM;
    @FXML private TableColumn<MemoryTableCell, Integer> tableColumnRAMAddr;
    @FXML private TableColumn<MemoryTableCell, Integer> tableColumnRAMData;
    private ObservableList<MemoryTableCell> tableViewRAMItems; //List, v ktorom su ulozene itemy tabulky

    //Stavovy riadok
	@FXML private ProgressBar progressBar;
	@FXML private Label lbStatus;

	//SplitPanely pre definovanie chovania bocnych zasuvacich okien
	@FXML private SplitPane splitPaneHoriz;
	@FXML private TitledPane titPaneRegisters;
	@FXML private AnchorPane anchPaneRegisters;
    @FXML private TitledPane titPaneConsole;
    @FXML private SplitPane splitPaneVert;

    private double lastConsoleDividerPos;   //posledna pozicia velkosti konzoly

    //Kontinualne updateovanie GUI
    @FXML private Slider sliderUpdateGUIInt;
    @FXML private Label lbUpdateGUIIntValue;
    @FXML private CheckMenuItem chmiSettingsAllowUpdateGUI;
    @FXML private HBox hboxUpdateGUIInt;
    volatile private int GUIUpdateInt = 150;

    private Service updateGUIService = new Service() {
        @Override
        protected Task createTask() {
            return new Task() {
                CountDownLatch cdl;

                private ChangeListener<Boolean> executionListener =  new ChangeListener<Boolean>() {
                    @Override public void changed(ObservableValue<? extends Boolean> observable, Boolean oldValue, Boolean newValue) {
                        if( newValue ) cdl.countDown(); } };

                private ChangeListener<Boolean> pauseListener =  new ChangeListener<Boolean>() {
                    @Override public void changed(ObservableValue<? extends Boolean> observable, Boolean oldValue, Boolean newValue) {
                        if( !newValue ) cdl.countDown(); } };

                @Override
                protected Object call() throws Exception {
                    while(!isCancelled()){
                        if (f_in_execution.getValue() && !f_paused.getValue()) {
                            //ak sa program vykonava ale nie je pauznuty, obnovuj GUI s danou frekvenciou
                            Platform.runLater(() -> updateGUI());
                            try {
                                Thread.sleep(GUIUpdateInt);
                            } catch (InterruptedException e) {
                                return null;
                            }
                        } else {
                            //inak cakaj na beh programu
                            cdl = new CountDownLatch(1);
                            f_in_execution.addListener(executionListener);
                            f_paused.addListener(pauseListener);
                            try {
                                cdl.await();
                            } catch (InterruptedException e){
                                return null;
                            } finally {
                                f_in_execution.removeListener(executionListener);
                                f_paused.removeListener(pauseListener);
                            }
                        }
                    }
                    return null;
                }
            };
        }
    };

	/**
	 * Inicializácia potrebných atribútov, konzoly na výpis, editora kódu a pridanei akcelerátorov na ovládanie riadenia CPU
	 */
	public void initialize(URL location, ResourceBundle resources) {
	    //inizializacia atributov
        f_intBylevel = true;
        f_in_execution = new SimpleBooleanProperty(false);
        f_paused = new SimpleBooleanProperty(false);
        execution_line = new SimpleIntegerProperty(-1);
        fileSaved = true; //aj cisty kod je kvazi ulozeny

        //Inicializacia konzoly
        console = new InlineCssTextArea();
        console.setEditable(false);
        consolePane.getChildren().add(new VirtualizedScrollPane<>(console));

        //struktura pre breakpointy
        breakpointLines = new TreeSet<>();
        observableBreakpointLines = FXCollections.synchronizedObservableSet( FXCollections.observableSet(breakpointLines) );

		//Inicializacia editora kodu
        codeEditor = CodeEditorFactory.getCodeEditor(codeAreaPane, observableBreakpointLines);
        codeEditor.richChanges()
                .filter(ch -> !ch.getInserted().getText().equals(ch.getRemoved().getText()))
                .subscribe(change -> {
                    if (this.program != null) {
                        this.program.removeListenerOnBreakpointsChange(observableBreakpointLines);
                        this.program = null; //zmena v kode -> program nie je aktualny
                    }

                    //cpu = null;
                    btnStart.setText(BTN_TXT_START);

                    if(fileSaved) { //ozacenie v liste, ze kod nie je ulozeny
                        titPaneCode.setText(titPaneCode.getText() + "*");
                        fileSaved = false;
                    }
                });

		//Listenery na zmenu zobrazenia registrov a pamati
		btnGroupRegisters.selectedToggleProperty().addListener( (observable, oldValue, newValue)->{
            displayFormRegisters = onToggleGroupChange(btnGroupRegisters, oldValue, newValue);
            updateGUIRegisters();});
		btnGroupStackAddr.selectedToggleProperty().addListener( (observable, oldValue, newValue)->{
            displayFormStackAddr = onToggleGroupChange(btnGroupStackAddr, oldValue, newValue);
            updateGUITableForm(tableViewStackItems, displayFormStackAddr, displayFormStackData);});
		btnGroupStackData.selectedToggleProperty().addListener( (observable, oldValue, newValue)->{
            displayFormStackData = onToggleGroupChange(btnGroupStackData, oldValue, newValue);
            updateGUITableForm(tableViewStackItems, displayFormStackAddr, displayFormStackData);});
		btnGroupProgMemoryAddr.selectedToggleProperty().addListener( (observable, oldValue, newValue)->{
            displayFormProgMemoryAddr = onToggleGroupChange(btnGroupProgMemoryAddr, oldValue, newValue);
            updateGUITableForm(tableViewProgMemoryItems, displayFormProgMemoryAddr, displayFormProgMemoryData);});
		btnGroupProgMemoryData.selectedToggleProperty().addListener( (observable, oldValue, newValue)->{
            displayFormProgMemoryData = onToggleGroupChange(btnGroupProgMemoryData, oldValue, newValue);
            updateGUITableForm(tableViewProgMemoryItems, displayFormProgMemoryAddr, displayFormProgMemoryData);});
        btnGroupRAMAddr.selectedToggleProperty().addListener( (observable, oldValue, newValue)->{
            displayFormRAMAddr = onToggleGroupChange(btnGroupRAMAddr, oldValue, newValue);
            updateGUITableForm(tableViewRAMItems, displayFormRAMAddr, displayFormRAMData);});
        btnGroupRAMData.selectedToggleProperty().addListener( (observable, oldValue, newValue)->{
            displayFormRAMData = onToggleGroupChange(btnGroupRAMData, oldValue, newValue);
            updateGUITableForm(tableViewRAMItems, displayFormRAMAddr, displayFormRAMData);});

		//inicializacia stavov zobrazenia registrov a pamati na decimalne zobrazenie
		displayFormRegisters = eRepresentation.Dec;
		displayFormStackAddr = eRepresentation.Dec;
		displayFormStackData = eRepresentation.Dec;
		displayFormProgMemoryAddr = eRepresentation.Dec;
		displayFormProgMemoryData = eRepresentation.Dec;
        displayFormRAMAddr = eRepresentation.Dec;
        displayFormRAMData = eRepresentation.Dec;

        //inicializacia tlacitok
        btnParse.setDisable(false);
        btnStart.setDisable(false);
        btnStep.setDisable(false);
        btnPause.setDisable(true);
        btnStop.setDisable(true);
        btnReset.setDisable(true);

        btnSimulator.setDisable(true);

        //inicializacia pozicie oddelovacov v horizontalnom SplitPaneli
        defSplitPaneHorizDividerPositions = splitPaneHoriz.getDividerPositions();

        splitPaneVert.getDividers().get(0).setPosition(0.71);
        titPaneConsole.expandedProperty().addListener(new ChangeListener<Boolean>() {
            @Override
            public void changed(ObservableValue<? extends Boolean> observable, Boolean oldValue, Boolean newValue) {
                if(newValue)    //ak je otvoreny
                    splitPaneVert.getDividers().get(0).setPosition(lastConsoleDividerPos);
                else {    //ak je zatvoreny
                    lastConsoleDividerPos = splitPaneVert.getDividers().get(0).getPosition();
                    splitPaneVert.getDividers().get(0).setPosition(1);
                }
            }
        });

        //Akceleratory
        Platform.runLater(()->{
            btnParse.getScene().getAccelerators().put(new KeyCodeCombination(KeyCode.F4), ()->btnParse.fire());
            btnStart.getScene().getAccelerators().put(new KeyCodeCombination(KeyCode.F5), ()->btnStart.fire());
            btnStep.getScene().getAccelerators().put(new KeyCodeCombination(KeyCode.F7), ()->btnStep.fire());
            btnPause.getScene().getAccelerators().put(new KeyCodeCombination(KeyCode.F9), ()->btnPause.fire());
            btnReset.getScene().getAccelerators().put(new KeyCodeCombination(KeyCode.F12), ()->btnReset.fire());
            btnStop.getScene().getAccelerators().put(new KeyCodeCombination(KeyCode.F10), ()->btnStop.fire());
            // komentovanie bloku
            btnStop.getScene().getAccelerators().put(new KeyCodeCombination(KeyCode.SLASH, KeyCombination.CONTROL_DOWN), ()->blockComment());
            // zmensenie pisma
            btnStop.getScene().getAccelerators().put(new KeyCodeCombination(KeyCode.F9, KeyCombination.CONTROL_DOWN), ()->{
                if (fontSize > 7) {
                    fontSize--;
                    codeEditor.setStyle("-fx-font-size: " + fontSize +"pt;");
                }
            });
            // zvecsenie pisma
            btnStop.getScene().getAccelerators().put(new KeyCodeCombination(KeyCode.F10, KeyCombination.CONTROL_DOWN), ()->{
                if (fontSize < 28) {
                    fontSize++;
                    codeEditor.setStyle("-fx-font-size: " + fontSize +"pt;");
                }
            });

            btnStop.getScene().getAccelerators().put(new KeyCodeCombination(KeyCode.F12, KeyCombination.CONTROL_DOWN), () -> {
                if (f_logEnabled) {
                    f_logEnabled = false;
                    CPU.stopTimesDebug();
                    Notifications.create()
                            .title("DEBUG")
                            .text("Logovanie vypnuté")
                            .showWarning();
                }
                else {
                    f_logEnabled = true;
                    CPU.startTimesDebug();
                    Notifications.create()
                            .title("DEBUG")
                            .text("Logovanie zapnuté")
                            .showWarning();
                }
            });
        });

        //Stavovy riadok - GUI Update
        sliderUpdateGUIInt.valueProperty().addListener(new ChangeListener<Number>() {
            @Override
            public void changed(ObservableValue<? extends Number> observable, Number oldValue, Number newValue) {
                GUIUpdateInt = (int) sliderUpdateGUIInt.getValue();
                lbUpdateGUIIntValue.setText(String.valueOf(GUIUpdateInt));
            }
        });

        initCPU();
        initializeGUITables();
        updateGUI();

        // defaultne zapnutie updateovania GUI EZFix
        handleMenuSettingsAllowUpdateGUIAction();
    }

    /**
     * Komentovanie bloku textu
     *
     */
    public void blockComment(){
        IndexRange range = codeEditor.getSelection();
        int start = range.getStart();
        int end = range.getEnd();

        String str = codeEditor.getText();
        // rozsirenie vyberu, aby zacinal na zaciatku riadku
        for (int i = start; i >= 0; i--) {
            if (str.getBytes()[i] == '\n'){
                start = i + 1;
                break;
            }
            if (i == 0)
                start = 0;
        }

        // zakomentovane je, ak je na zaciatku kazdeho riadku komentar
        boolean komentar = true;
        if (str.getBytes()[start] == ';'){
            for (int i = start; i < end - 1; i++)
                if ((str.getBytes()[i] == '\n') && (str.getBytes()[i+1] != ';')) {
                    komentar = false;
                    break;
                }
        }
        else
            komentar = false;

        if (komentar) {
            // odkomentovanie
            // ak je na konci \n, nezamenime ho
            if (str.getBytes()[end-1] == '\n'){
                // vo vybere vynechame prvu bodkociarku
                String vyber = codeEditor.getText(start + 1, end - 1);
                codeEditor.replaceText(start, end, vyber.replaceAll("\n;","\n") + "\n");
            }
            else{
                // vo vybere vynechame prvu bodkociarku
                String vyber = codeEditor.getText(start + 1, end);
                codeEditor.replaceText(start, end, vyber.replaceAll("\n;","\n"));
            }
        }
        else {
            // zakomentovanie
            // ak je na konci \n, nezamenime ho za komentar
            if (str.getBytes()[end-1] == '\n'){
                String vyber = codeEditor.getText(start, end - 1);
                codeEditor.replaceText(start, end, ";" + vyber.replaceAll("\n","\n;") + "\n");
            }
            else{
                String vyber = codeEditor.getText(start, end);
                codeEditor.replaceText(start, end, ";" + vyber.replaceAll("\n","\n;"));
            }
        }

//        // ak je na konci \n, nezamenime ho za komentar
//        if (str.getBytes()[end-1] == '\n'){
//            String vyber = codeEditor.getText(start, end - 1);
//            codeEditor.replaceText(start, end, ";" + vyber.replaceAll("\n","\n;") + "\n");
//        }
//        else{
//            String vyber = codeEditor.getText(start, end);
//            codeEditor.replaceText(start, end, ";" + vyber.replaceAll("\n","\n;"));
//        }
    }

    /**
     * Preposlanie stlačenej klávesy do CPU
     *
     * @param event Klávesa
     */
    public void keyboardInput(KeyEvent event){
	    if(cpu != null)
            cpu.setKeyPressed(event);
    }

    /**
     * Informácia, či sa práve vykonáva program zavedený na CPU.
     * @return True ak sa vykonáva, false inak.
     */
    public boolean isExecuting(){
        return f_in_execution.getValue();
    }

    /**
     * Ukončenie aplikácie. V prípade, že aktuálny kód nie je uložený, užívateľ je upozornený.
     *
     * @return True ak má byť aplikácia ukončená
     */
    public boolean exit(){
        if(!fileSaved && !continueIfUnsavedFile()) return false;
        if (!continueIfUnsavedSchematic()) return false;
        Platform.exit();
        return true;
    }

    /**
     * Nastavnie okna, ktoré sa má zobraziť po kliknutí na tlačidlo otvorenia simulátora.
     *
     * @param stageToShow Javisko so simulátorom - schémou.
     */
    public void setSchematicStage(Stage stageToShow) {
        this.schematicStage = stageToShow;
        this.btnSimulator.setDisable(false);
    }

    /**
     * Nastavenie plochy schémy, s ktorou CPU komunikuje cez zbernicu.
     */
    public void setSchematicSheet(SchematicSheet sheet) {
        this.schematicSheet = sheet;
    }

    /**
     * Nastavenie controlleru okna schémy (kvôli uloženiu schémy pri ukončení programu).
     */
    public void setSchematicController(SchematicController controller) {
        this.schematicController = controller;
    }

    /**
     * Verejná vlastnosť stavu CPU - pre okno simulátora, ktoré podľa neho povoluje/zakazuje
     * tlačidlá behu programu.
     */
    public Property<CPUStates> cpuStateProperty() {
        return cpu != null ? cpu.stateProperty() : null;
    }

    /**
     * Inicializacia tabuliek pre pamate - Zasobnik , Konstanty programu, RAM
     */
    private void initializeGUITables(){
        //inicializacia tabulky zasobnika
        tableViewStackItems = FXCollections.observableArrayList();      //vytvorenie ArrayListu pre ukladanie itemov
        tableViewStackItems.add(new StackTableCell(0,0)); //vytvorenie nultej adresy
        for (int i = 65535; i > 0; i--)                                 //vytvorenie zvyskych adries zasobnika
            tableViewStackItems.add(new StackTableCell(i,0));
        tableViewStack.setItems(tableViewStackItems);                   //priradenie pola do tabulky

        //faktorka na riadky - pridavanie pseudotried pre vrchol zasobnika a zmenene data
        tableViewStack.setRowFactory(tv ->
            new TableRow<StackTableCell>(){
                @Override
                protected void updateItem(StackTableCell item, boolean empty) {
                    super.updateItem(item, empty);

                    pseudoClassStateChanged(pcStackHead, (!empty) && item.getAddressInt() == StackTableCell.getStackHead());
                    pseudoClassStateChanged(pcDataChanged, (!empty) && item.isChanged());
                }
            }
        );

        //priradenie atributov polozky k stlpcom
        tableColumnStackAddr.setCellValueFactory( new PropertyValueFactory<>("address"));
        tableColumnStackData.setCellValueFactory( new PropertyValueFactory<>("data"));


        //inicializacia tabulky konstant
        tableViewProgMemoryItems = FXCollections.observableArrayList();         //vytvorenie ArrayListu pre ukladanie itemov
        for (int i = 0; i < 256; i++)                                          //vytvorenie zvyskych adries zasobnika
            tableViewProgMemoryItems.add(new MemoryTableCell(i,0));
        tableViewProgMemory.setItems(tableViewProgMemoryItems);                 //priradenie pola do tabulky

        //priradenie atributov polozky k stlpcom
        tableColumnProgMemoryAddr.setCellValueFactory( new PropertyValueFactory<>("address"));
        tableColumnProgMemoryData.setCellValueFactory( new PropertyValueFactory<>("data"));


        //inicializacia tabulky RAM
        tableViewRAMItems = FXCollections.observableArrayList();         //vytvorenie ArrayListu pre ukladanie itemov
        for (int i = 0; i < 256; i++)                                          //vytvorenie zvyskych adries zasobnika
            tableViewRAMItems.add(new MemoryTableCell(i,0));
        tableViewRAM.setItems(tableViewRAMItems);                               //priradenie pola do tabulky

        //faktorka na riadky - pridavanie pseudotried pre zmenene data
        tableViewRAM.setRowFactory(tv ->
            new TableRow<MemoryTableCell>(){
                @Override
                protected void updateItem(MemoryTableCell item, boolean empty) {
                    super.updateItem(item, empty);
                    pseudoClassStateChanged(pcDataChanged, (!empty) && item.isChanged());
                }
            }
        );

        //priradenie atributov polozky k stlpcom
        tableColumnRAMAddr.setCellValueFactory( new PropertyValueFactory<>("address"));
        tableColumnRAMData.setCellValueFactory( new PropertyValueFactory<>("data"));
    }

    /**
     * Vracia reprezentáciu vybraného zobrazenia informacii v danej skupine prepínacích tlačidiel.
     * Pri odznačení tlačidla ho opät zaznčí späť. Ak sa vyskytne chyba, vráti Hexa reprezentáciu.
     *
     * @param btnGroup Skupina prepínacích tlačidiel, na ktorej bola vykonaná zmena
     * @param oldValue Posledné aktivované tlačidlo
     * @param newValue Nové aktivované tlačidlo
     * @return Reprezentácia vybraného zobrazenia
     */
    private eRepresentation onToggleGroupChange(ToggleGroup btnGroup, Toggle oldValue, Toggle newValue){
        ToggleButton tb;
        if(newValue != null) {
            tb = (ToggleButton) newValue;
        } else {
            btnGroup.selectToggle(oldValue);
            tb = (ToggleButton) oldValue;
        }
        try {
            return eRepresentation.valueOf(tb.getText());
        } catch (IllegalArgumentException e){
            return eRepresentation.Hex;
        }
    }

    /**
     * Zmaze dany styl zo vsetkych paragrafov v editore
     *
     * @param style Styl, ktory sa ma zmazat
     */
	private void clearCodeStyle(String style){
        for (int i = 0; i < codeEditor.getParagraphs().size(); i++){
            if(codeEditor.getParagraph(i)
                    .getParagraphStyle()
                    .stream()
                    .anyMatch( s -> s.contains(style))){
                RichTextFXHelpers.tryRemoveParagraphStyle(codeEditor, i, style);
            }
        }
    }

	/**
	 * Vypíše farebný text na nový riadok v konzole
     *
	 * @param text Text, ktorý sa má vypisať na konzolu
	 * @param color Farba textu
	 */
	private void writeConsoleLn(String text, String color){
		int paragraph = console.getCurrentParagraph();

		//ak uz v riadku nieco je, skoc na novy
		if(console.getParagraph(paragraph).getText().length() > 0) {
            console.appendText("\n");
            paragraph = console.getCurrentParagraph();
        }

		console.setStyle(paragraph, "-fx-fill: " + color);
		console.appendText(text + "\n");
		console.moveTo(console.getText().length());
		console.requestFollowCaret();
	}

	//HANDLERS

	//Zobrazovanie / skryvanie bocnych panelov
    private double[] defSplitPaneHorizDividerPositions;

    /**
     * Zobrazí / skryje panel registrov po kliknutí na tlačidlo
     */
	@FXML
    private void handleToggleRegistersPaneAction(){
        toggleSplitPaneDivider(true, 0, 0);
    }

    /**
     * Zobrazí / skryje panel pamätí po kliknutí na tlačidlo
     */
    @FXML
    private void handleToggleMemoryPaneAction(){
        toggleSplitPaneDivider(false, 1, 1);
    }

    /**
     * Na základe aktuálnej pozície oddeľovača v splitpaneli vysunie / zasunie bočný panel animovaním pozície oddeľovača,
     * ktorý je daný indexom.
     *
     * @param decrementToHide Ak je skytie panelu realizované pohybom oddeľovača vľavo
     * @param dividerIndex Index oddeľovača v rámci splitPanel-u
     * @param hidedAt Percentuálna pozícia, pri ktorej sa panel berie ako skytý
     */
    private void toggleSplitPaneDivider(boolean decrementToHide, int dividerIndex, double hidedAt){
        // create an animation to hide sidebar.
        final Animation hideSidebar = new Transition() {
            { setCycleDuration(Duration.millis(250)); }
            protected void interpolate(double frac) {
                double perc = splitPaneHoriz.getDividers().get(dividerIndex).getPosition();
                if(decrementToHide)
                    splitPaneHoriz.setDividerPosition(dividerIndex, (perc - frac * perc));
                else
                    splitPaneHoriz.setDividerPosition(dividerIndex, perc + frac * (1-perc));
            }
        };

        // create an animation to show a sidebar.
        final Animation showSidebar = new Transition() {
            { setCycleDuration(Duration.millis(250)); }
            protected void interpolate(double frac) {
                if(decrementToHide)
                    splitPaneHoriz.setDividerPosition(dividerIndex, frac * defSplitPaneHorizDividerPositions[dividerIndex]);
                else
                    splitPaneHoriz.setDividerPosition(dividerIndex, 1 - frac * defSplitPaneHorizDividerPositions[dividerIndex]);
            }
        };

        if (showSidebar.statusProperty().get() == Animation.Status.STOPPED && hideSidebar.statusProperty().get() == Animation.Status.STOPPED) {
            if (Math.abs(hidedAt - splitPaneHoriz.getDividers().get(dividerIndex).getPosition()) > 0.03) {
                hideSidebar.play();
            } else {
                showSidebar.play();
            }
        }
    }


    //MENU
    @FXML
    private void handleMenuSettingsINTLevelAction(){
        onChangeIntByLevel(true);
    }

    @FXML
    private void handleMenuSettingsINTChangeAction(){
        onChangeIntByLevel(false);
    }

    /**
     * Zmena nastavenia vyhodnocovania prerušenia na CPU.
     * @param newVal True ak sa má vyhodnocovať prerušenie od úrovne, false ak od zmeny.
     */
    private void onChangeIntByLevel(boolean newVal){
        f_intBylevel = newVal;
        if(cpu != null)
            cpu.setIntLevel(f_intBylevel);

        chmiSettingsINTLevel.setSelected(newVal);
        chmiSettingsINTChange.setSelected(!newVal);
    }

    /**
     * Zapnutie resp. vypnutie mikrokrokovania.
     */
    @FXML
    private void handleMenuSettingsMicrostepAction(){
        boolean isSelected = chmiSettingsMicrostep.isSelected();
        f_microstep = isSelected;
        if (cpu != null)
            cpu.setMicrostep(isSelected);

        chmiSettingsMicrostep.setSelected(isSelected);
    }

    /**
     * Povolenie stálej aktualizácie GUI počas vykonávania programu.
     */
    @FXML
    private void handleMenuSettingsAllowUpdateGUIAction(){
        boolean isSelected = chmiSettingsAllowUpdateGUI.isSelected();

        if (isSelected) {
            updateGUIService.restart();
            hboxUpdateGUIInt.setDisable(false);
        } else {
            updateGUIService.cancel();
            hboxUpdateGUIInt.setDisable(true);
        }

        chmiSettingsAllowUpdateGUI.setSelected(isSelected);
    }

    /**
     * Obsluha položky menu pri vytváraní nového súboru.
     */
    @FXML
    private void handleMenuFileNewAction(){
        if(!fileSaved && !continueIfUnsavedFile()) return;

        codeEditor.clear();
        titPaneCode.setText(CODE_PANE_TEXT);
        currentFile = null;
        fileSaved = true;
        // nazov suboru do nazvu aplikacie
        primStage.setTitle("CPU Emulator - nový program");
    }

    /**
     * Obsluha položky menu pre otvorenie súboru s kódom.
     */
   	@FXML
	private void handleMenuFileOpenAction(){
        if (isExecuting()) handleButtonStopAction();
        if(!fileSaved && !continueIfUnsavedFile()) return;

        FileChooser chooser = new FileChooser();
        chooser.setTitle("Otvoriť súbor...");
        chooser.setInitialDirectory(
                currentFile != null
                        ? currentFile.getParentFile()
                        : new File(Paths.get("").toAbsolutePath().toString()));
        chooser.getExtensionFilters().addAll(
                new FileChooser.ExtensionFilter("ASM","*.asm"),
                new FileChooser.ExtensionFilter("TXT", "*.txt"));

        File file = chooser.showOpenDialog(btnLoadCode.getScene().getWindow());

        if(file != null)
            try (BufferedReader br = new BufferedReader(new InputStreamReader(
                    new FileInputStream(file), StandardCharsets.UTF_8))) {
                codeEditor.clear();
                StringBuilder sb = new StringBuilder();
                br.lines().forEach(line -> {
                    sb.append(line + "\n");
                });
                codeEditor.appendText(sb.toString());
                currentFile = file;
                titPaneCode.setText("Kód - " + currentFile.getName());
                fileSaved = true;
                // nazov suboru do nazvu aplikacie
                primStage.setTitle("CPU Emulator - " + currentFile.getName());

            } catch (FileNotFoundException e) {
                e.printStackTrace();
            } catch (IOException e) {
                e.printStackTrace();
            }
    }

    /**
     * Obsluha položky menu pre uloženie kódu do súboru.
     */
	@FXML
	private void handleMenuFileSaveAction(){
	    saveCode(false);
	}

    /**
     * Obsluha položky menu pre uloženie kódu do iného súboru.
     */
	@FXML
    private void handleMenuFileSaveAsAction(){
        saveCode(true);
    }

    /**
     * Obsluha položky menu pre ukončenie aplikácie.
     */
    @FXML
    private void handleMenuFileExitAction(){
        if(this.cpu != null) this.cpu.cancel();
        exit();
    }

    /**
     * Okno about
     */
    @FXML
    private void handleMenuAboutAction(){
        JDialog f = new AboutDialog(new JFrame());
        f.setVisible(true);
    }

    /**
     * Výstraha pre užívateľa s otázkou na ďalší postup, ak aktuálny súbor nie je uložený.
     *
     * @return true - volajúca procedúra môže pokračovať, false - užívateľ nechce pokračovať
     */
    private boolean continueIfUnsavedFile(){
        if(codeEditor.getText().trim().isEmpty()) return true;

        Alert alert = new Alert(Alert.AlertType.CONFIRMATION);
        alert.setTitle("Potvrdenie");
        alert.setHeaderText("Zmeny vo vašom kóde neboli uložené");
        alert.setContentText("Prajete si uložiť zmeny?");

        ButtonType btnTypeSave = new ButtonType("Uložiť");
        ButtonType btnTypeSaveAs = new ButtonType("Uložiť ako");
        ButtonType btnTypeNo = new ButtonType("Nie");
        ButtonType btnTypeCancel = new ButtonType("Zrušiť");


        alert.getButtonTypes().clear();
        if(currentFile != null) alert.getButtonTypes().add(btnTypeSave);
        alert.getButtonTypes().addAll(btnTypeSaveAs, btnTypeNo, btnTypeCancel);

        Optional<ButtonType> result = alert.showAndWait();

        if(result.get() == btnTypeCancel){
            return false;
        } else if(result.get() == btnTypeSaveAs){
            return saveCode(true);
        } else  if(result.get() == btnTypeSave){
            return saveCode(false);
        }

        return true;
    }

    /**
     * Výstraha pre užívateľa s otázkou na ďalší postup, ak aktuálna schéma nie je uložená.
     *
     * @return true - volajúca procedúra môže pokračovať, false - užívateľ chce zostať
     */
    private boolean continueIfUnsavedSchematic() {
        if (schematicSheet == null || !schematicSheet.hasChanged()) return true;
        if (schematicController == null) return true;

        Alert alert = new Alert(Alert.AlertType.CONFIRMATION);
        alert.setTitle("Potvrdenie");
        alert.setHeaderText("Zmeny v schéme neboli uložené");
        alert.setContentText("Prajete si uložiť zmeny?");

        ButtonType btnTypeSave = new ButtonType("Uložiť");
        ButtonType btnTypeSaveAs = new ButtonType("Uložiť ako");
        ButtonType btnTypeNo = new ButtonType("Nie");
        ButtonType btnTypeCancel = new ButtonType("Zrušiť");

        alert.getButtonTypes().clear();
        if (schematicController.hasCurrentFile()) alert.getButtonTypes().add(btnTypeSave);
        alert.getButtonTypes().addAll(btnTypeSaveAs, btnTypeNo, btnTypeCancel);

        Optional<ButtonType> result = alert.showAndWait();
        if (!result.isPresent() || result.get() == btnTypeCancel) {
            return false;
        } else if (result.get() == btnTypeSaveAs) {
            return schematicController.saveCircuit(true);
        } else if (result.get() == btnTypeSave) {
            return schematicController.saveCircuit(false);
        }

        return true;
    }

    /**
     * Uloženie aktuálneho kódu nachádzajúceho sa v editore kódu do súboru.
     * Súbor môže užívateľ špecifikovať, alebo sa použije naposledy otvorený súbor, ak taký existuje.
     *
     * @param saveAs True - uloženie do iného súboru, ako je naposledy otovrený
     * @return True ak bol súbor uložený, False inak
     */
	private boolean saveCode(boolean saveAs){
        File file = saveAs?null:currentFile;

        if(currentFile == null || saveAs) {
            FileChooser chooser = new FileChooser();
            chooser.setTitle("Uložiť" + (saveAs?" ako":"") + "..");
            chooser.setInitialDirectory(new File(Paths.get("").toAbsolutePath().toString()));
            chooser.getExtensionFilters().addAll(
                    new FileChooser.ExtensionFilter("ASM", "*.asm"),
                    new FileChooser.ExtensionFilter("TXT", "*.txt"));

            if(currentFile != null)
                chooser.setInitialFileName(currentFile.getName());

            file = chooser.showSaveDialog(btnSaveCode.getScene().getWindow());
        }

        if(file != null) {
            try (PrintWriter out = new PrintWriter(
                    new OutputStreamWriter(
                            new FileOutputStream(file), StandardCharsets.UTF_8))) {
                out.print(codeEditor.getDocument().getText());
                currentFile = file;
                titPaneCode.setText("Kód - " + currentFile.getName());
                fileSaved = true;
                // nazov suboru do nazvu aplikacie
                primStage.setTitle("CPU Emulator - " + currentFile.getName());

                return true;
            } catch (FileNotFoundException e) {
                return false;
            }
        } else {
            return false;
        }
    }

    //EDITOR KODU

    /**
     * Obsluha tlačidla pre zrušenie všetkých vytvorených breakpointov v kóde.
     */
    @FXML
	private void handleButtonUnbreakAllAction(){
	    observableBreakpointLines.clear();
	}

	//OVLADANIE VYKONAVANIA CPU

    /**
     * Obsluha tlačidla pre parsovanie kódu z editoru.
     */
	@FXML
	private void handleButtonParseAction(){
        parseCode(false);
	}

    /**
     * Obsluha tlačidla pre pozastavenie vykonávania CPU.
     */
	@FXML
    public void handleButtonPauseAction(){
        if(cpu == null) return;
        cpu.pauseExecute();
	}

    /**
     * Obsluha tlačidla pre resetovanie stavu CPU a stavu zbernice.
     */
	@FXML
    public void handleButtonResetAction(){
	    if(cpu != null)
            cpu.reset();

	    Bus.getBus().reset();

        updateGUI();
        updateGUI(); //zrusenie cerveneho zvyraznenia novych hodnot
	}

    /**
     * Obsluha tlačidla pre spustenie vykonávania CPU.
     * Ak bolo CPU pozastavené, spustí pokračovanie vo vykonávaní.
     */
	@FXML
	public void handleButtonStartAction(){
        f_startPaused = false;
        if (f_in_execution.getValue() && f_paused.getValue()) {
            //ak je iba pozastavene vykonavanie
            cpu.continueExecute();
        } else {
            startCPUAction();
        }
    }

    /**
     * Obsluha tlačidla pre vkonanie kroku a presunu na ďalšiu inštrukciu.
     */
	@FXML
    public void handleButtonStepAction(){
        f_startPaused = true;
        if (f_in_execution.getValue()) {
            cpu.step();
        } else {
            startCPUAction();
        }
    }

    /**
     * Obsluha tlačidla pre zastavenie vykonávania CPU.
     */
	@FXML
    public void handleButtonStopAction(){
        cpu.stopExecute();
        cos_cpu.clearBuffer();
    }

    /**
     * Ak je aktuálny kód v editore parsovaný a zavedený do programu, zašle príkaz na spustenie vykonávania CPU.
     * Inak najprv parsuje kód.
     */
    private void startCPUAction(){
        if(this.program == null) {
            //este nie je parsovany kod
            parseCode(true);
        } else {
            //kod uz je parsovany, staci spustit CPU
            startExecution();
        }
    }

    //TLACIDLO PRE OTVORENIE SIMULATORA
    @FXML
    private void handleButtonSimulatorAction() {
        if (schematicStage.isShowing()) {
            schematicStage.hide();
        } else {
            schematicStage.show();
        }
    }

    //KONZOLA

    /**
     * Obsluha tlačidla pre vymazanie obsahu konzoly.
     */
    @FXML
    private void handleButtonConsoleClearAction(){
        console.clear();
    }

    /**
     * Obsluha tlačidla pre posun zobrazenia tabuľky zásobníka na vrchol podľa registra SP.
     */
    @FXML
    private void handleButtonToStackHeadAction(){
        if(cpu != null) {
            int SP = Short.toUnsignedInt(cpu.getRegSP());
            if (SP == 0)
                tableViewStack.scrollTo(0);
            else
                tableViewStack.scrollTo(65535 - SP -5);
        }
        else
            tableViewStack.scrollTo(0);
    }

    //KONIEC HANDLEROV

    /**
     * V novom vlákne spustí parsovanie kódu z editoru.
     * Aktualizuje stav parsovania. Po úspešnom parsovaní sa vytvorí program.
     *
     * @param startExecution True, ak sa má po úspešnom parosvaní program aj spustiť, False ak sa nemá spustiť.
     */
    private void parseCode(boolean startExecution){
        //pocet riadkov v editore pre update progress baru
        int lines = codeEditor.getParagraphs().size();
        //vytvorenie parsera
        Parser parserTask = new Parser(codeEditor.getText(), lines);

        //vycistenie editoru ak boli chyby
        clearCodeStyle(STYLE_PARAGRAPH_ERROR);

        //zobrazenie stavu parsovania
        progressBar.progressProperty().unbind();
        progressBar.progressProperty().bind(parserTask.progressProperty());
        lbStatus.setText("Parsujem...");

        Thread parserThread = new Thread(parserTask);
        //zastavenie vlakna ak skonci aplikacia
        parserThread.setDaemon(true);

        parserTask.setOnSucceeded(new EventHandler<WorkerStateEvent>() {
            @Override
            public void handle(WorkerStateEvent event) {
                writeConsoleLn("Program úspešne zavedený!", "green");

                if(program != null) //odhlasenie stareho listenera na zmeny v braekpointoch
                    program.removeListenerOnBreakpointsChange(observableBreakpointLines);

                program = parserTask.getValue();
                program.setListenerOnBreakpointsChange(observableBreakpointLines);

                updateGUITableProgMemory();

                lbStatus.setText("Program zavedený");

                //ak ma byt spustene vykonavanie CPU
                if(startExecution)
                    startExecution();
            }
        });

        parserTask.setOnFailed(new EventHandler<WorkerStateEvent>() {
            @Override
            public void handle(WorkerStateEvent event) {
                InvalidCodeLinesException ex = (InvalidCodeLinesException) parserTask.getException();

                //zvyraznenie riadkov s chybovym kodom
                for (int line :
                        ex.getLines()) {
                    RichTextFXHelpers.addParagraphStyle(codeEditor, line, STYLE_PARAGRAPH_ERROR);
                }

                //vypisanie chybnych riadkov s popoisom na konzolu
                for (String msg :
                        ex.getErrors()) {
                    writeConsoleLn("[Parser] " + msg, "red");
                }

                program = null;
                updateGUITableProgMemory();

                //zobrazenie stavu
                lbStatus.setText("Chyba v kóde");
            }
        });

        //spustenie vlakna pre parsovanie kodu
        parserThread.start();
    }

    /**
     * Vytvorenie, inicializácia a spustenie CPU, na ktorom sa vykonáva parsovaný program.
     * Pridáva listener na zmenu stavu a nastavuje intLevel a microstep flagy.
     */
    private void initCPU(){
        this.cos_cpu = new ConsoleOutputStream(console);
        this.cpu = new CPU(cos_cpu, Bus.getBus());
        this.cpu.setDaemon(true);
        this.cpu.setRuntimeErrorHandler(msg -> Platform.runLater(() -> writeConsoleLn("[CPU] " + msg, "red")));

        this.cpu.stateProperty().addListener( (observable,  oldValue,  newValue) -> onCPUStateChanged(newValue) );

        this.cpu.start();

        this.cpu.setIntLevel(f_intBylevel);
        this.cpu.setMicrostep(f_microstep);
    }

    /**
     * Ak beží vlákno s CPU, resetuje jeho stav, zavedie aktuálny parsovaný program a spustí vykonávanie.
     * Ak vlákno s CPU nie je aktívne, zavolá initCPU a znovu seba.
     */
    private void startExecution(){
        //ak cpu bezi
        if(this.cpu != null && this.cpu.isAlive()){
            if (this.program.hasIOInstruction()) {
                boolean wasRunning = schematicSheet.isSimulationRunning();
                schematicSheet.powerOn();
                if (!wasRunning)
                    //ak bola simulacia vypnuta, pockaj chvilu na zahriatie
                    try {
                        Thread.sleep(100);
                    } catch (InterruptedException e) {
                        e.printStackTrace();
                    }
            }

            this.cos_cpu.setUnused();
            this.cpu.reset();
            this.cpu.loadProgram(this.program);
            this.cpu.startExecute(f_startPaused);
        } else {
            initCPU();
            startExecution();
        }
    }

    /**
     * Definuje, aká metóda sa má zavolať pri zmene stavu CPU.
     * @param state Nový stav CPU
     */
    private void onCPUStateChanged(CPUStates state){
        Consumer<CPUStates> toDo = s->{
            switch (state){
                case Running:
                    onCPURunning();
                    break;
                case Paused:
                    onCPUPaused();
                    break;
                case Waiting:
                    onCPUWaiting();
                    break;
                case Idle:
                    onCPUIdle("Nečinný");
                    break;
                default:
                    onCPUIdle("Nejasný stav");
            }
        };

        if(!Platform.isFxApplicationThread())
            Platform.runLater(()->{
                toDo.accept(state);
            });
        else
            toDo.accept(state);
    }

    /**
     * Metóda volaná pri prechode CPU do stavu bežiaci.
     */
    private void onCPURunning(){
        f_paused.setValue(false);

        //ak sa predtym nevykonaval program
        if(!f_in_execution.getValue()) {
            f_in_execution.setValue(true);
        }

        updateExecutionLine( -1 );

        progressBar.progressProperty().unbind();
        progressBar.setProgress(-1);
        lbStatus.setText("Program sa vykonáva...");

        btnParse.setDisable(true);
        btnStart.setDisable(true);
        btnStep.setDisable(true);
        btnPause.setDisable(false);
        btnStop.setDisable(false);
        btnReset.setDisable(true);

        codeEditor.setEditable(false);
        // focus na editor (aby stlacenie medzery nesposobilo koniec programu, ak je focus na tlacidle Stop)
        codeEditor.requestFocus();
    }

    /**
     * Metóda volaná pri prechode CPU do stavu pozastavený.
     */
    private void onCPUPaused() {
        f_paused.setValue(true);

        updateExecutionLine( program.getLineOfInstruction(cpu.getRegPC()-1) );

        progressBar.progressProperty().unbind();
        progressBar.setProgress(0.5);
        lbStatus.setText(cpu.getMessage());

        btnStart.setText(BTN_TXT_CONTINUE);

        btnParse.setDisable(true);
        btnStart.setDisable(false);
        btnStep.setDisable(false);
        btnPause.setDisable(true);
        btnStop.setDisable(false);
        btnReset.setDisable(true);

        updateGUI();
    }

    /**
     * Metóda volaná pri prechode CPU do stavu čakajúci.
     */
    private void onCPUWaiting(){
        f_paused.setValue(true);

        updateExecutionLine( program.getLineOfInstruction(cpu.getRegPC()-1) );

        progressBar.progressProperty().unbind();
        progressBar.setProgress(0.5);

        lbStatus.setText(cpu.getMessage());

        btnParse.setDisable(true);
        btnStart.setDisable(true);
        btnStep.setDisable(true);
        btnPause.setDisable(true);
        btnStop.setDisable(false);
        btnReset.setDisable(true);

    }

    /**
     * Metóda volaná pri prechode CPU do stavu nečinný.
     */
    private void onCPUIdle(String statusText){
        f_in_execution.setValue(false);
        f_paused.setValue(false);

        updateExecutionLine( -1 );

        progressBar.progressProperty().unbind();
        progressBar.setProgress(0);
        lbStatus.setText(statusText);

        btnStart.setText(BTN_TXT_START);

        btnParse.setDisable(false);
        btnStart.setDisable(false);
        btnStep.setDisable(false);
        btnPause.setDisable(true);
        btnStop.setDisable(true);
        btnReset.setDisable(false);

        codeEditor.setEditable(true);

        updateGUI();
    }

    //AKTUALIZACIA GUI

    /**
     * Aktualizácia registrov a tabuliek GUI.
     */
    private void updateGUI(){
        updateGUIRegisters();
        updateGUITables();
    }

    /**
     * Aktializuje hodnoty v registroch na hodnoty z CPU. Ak CPU neexistuje, nastavý hodnoty na 0.
     */
    private void updateGUIRegisters(){
        if(cpu != null && cpu.isAlive()) {
            tfRegA.setText(getDisplayRepresentation(cpu.getRegA(), displayFormRegisters));
            tfRegB.setText(getDisplayRepresentation(cpu.getRegB(), displayFormRegisters));
            tfRegC.setText(getDisplayRepresentation(cpu.getRegC(), displayFormRegisters));
            tfRegD.setText(getDisplayRepresentation(cpu.getRegD(), displayFormRegisters));

            tfRegPC.setText(getDisplayRepresentation(cpu.getRegPC(), displayFormRegisters));
            tfRegSP.setText(getDisplayRepresentation(cpu.getRegSP(), displayFormRegisters));
            tfRegMP.setText(getDisplayRepresentation(cpu.getRegMP(), displayFormRegisters));

            tfFlagCY.setText(cpu.isFlagCY() ? "1" : "0");
            tfFlagZ.setText(cpu.isFlagZ() ? "1" : "0");
            tfFlagIE.setText(cpu.isFlagIE() ? "1" : "0");
        } else {
            tfRegA.setText(getDisplayRepresentation((byte) 0, displayFormRegisters));
            tfRegB.setText(getDisplayRepresentation((byte) 0, displayFormRegisters));
            tfRegC.setText(getDisplayRepresentation((byte) 0, displayFormRegisters));
            tfRegD.setText(getDisplayRepresentation((byte) 0, displayFormRegisters));

            tfRegPC.setText(getDisplayRepresentation((short) 0, displayFormRegisters));
            tfRegSP.setText(getDisplayRepresentation((short) 0, displayFormRegisters));
            tfRegMP.setText(getDisplayRepresentation((short) 0, displayFormRegisters));

            tfFlagCY.setText("0");
            tfFlagZ.setText("0");
            tfFlagIE.setText("0");
        }
    }

    /**
     * Aktualizácia všetkých tabuliek - zásobník, pamäť programu, RAM.
     */
    private void updateGUITables(){
        updateGUITableStack();
        updateGUITableProgMemory();
        updateGUITableRAM();
    }

    /**
     * Aktualizácia tabuľky zásobníka podľa hodnôt z CPU.
     */
    private void updateGUITableStack(){
        if(cpu != null) {
            byte[] stack = cpu.getStack();
            int SP = Short.toUnsignedInt(cpu.getRegSP());

            tableViewStackItems.get(0).setData(stack[0]);

            for (int i = 65535; i > 0; i--) {
                tableViewStackItems.get(65535 - i + 1).setData(stack[i]);
            }
            StackTableCell.setStackHead(SP);
        } else {
            for (int i = 0; i < tableViewStackItems.size(); i++) {
                tableViewStackItems.get(i).setData((byte) 0);
            }
            StackTableCell.setStackHead(0);
        }

        tableViewStack.getColumns().get(0).setVisible(false);
        tableViewStack.getColumns().get(0).setVisible(true);
        handleButtonToStackHeadAction();
    }

    /**
     * Aktualizácia tabuľky zavedených konštánt programu.
     */
    private void updateGUITableProgMemory(){
        if(program != null){
            byte[] progMem = program.getMemory();

            for (int i = 0; i < progMem.length; i++)
                tableViewProgMemoryItems.get(i).setData(progMem[i]);
            for (int i = progMem.length; i < tableViewProgMemoryItems.size(); i++)
                tableViewProgMemoryItems.get(i).setData((byte) 0);
        } else {
            for (int i = 0; i < tableViewProgMemoryItems.size(); i++)
                tableViewProgMemoryItems.get(i).setData((byte) 0);
        }
    }

    /**
     * Aktualizácia tabuľky pamäte RAM.
     */
    private void updateGUITableRAM(){
        if(cpu != null) {
            byte[] RAM = cpu.getRAM();

            for (int i = 0; i < RAM.length; i++)
                tableViewRAMItems.get(i).setData(RAM[i]);
        } else {
            for (int i = 0; i < tableViewRAMItems.size(); i++)
                tableViewRAMItems.get(i).setData((byte) 0);
        }
        tableViewRAM.getColumns().get(0).setVisible(false);
        tableViewRAM.getColumns().get(0).setVisible(true);
    }

    /**
     * Zmena zobrazenia hodnôt adresy a dát v tabuľkách pamätí.
     *
     * @param list List s obsahom tabuľky
     * @param addressRep Nová reprezentácia zobrazenia adresy
     * @param dataRep Nová reprezentácia zobrazenia dát
     */
    private void updateGUITableForm(ObservableList<? extends MemoryTableCell> list, eRepresentation addressRep, eRepresentation dataRep){
        if( list.get(0).getAddressRepresentation() != addressRep && list.get(0).getDataRepresentation() != dataRep){
            list.forEach(cell -> {
                cell.changeAddressRepresentation(addressRep);
                cell.changeDataRepresentation(dataRep);
            });
        } else if( list.get(0).getAddressRepresentation() != addressRep ){
            list.forEach(cell -> cell.changeAddressRepresentation(addressRep));
        } else {
            list.forEach(cell -> cell.changeDataRepresentation(dataRep));
        }
    }

    /**
     * Akutalizácia zvýraznenia riadku aktuálne vykonávanej inštrukcie v editore kódu.
     *
     * @param lineIndex Index riadku s aktuálne vykonávanou inštrukciou
     */
    private void updateExecutionLine(int lineIndex){
        RichTextFXHelpers.tryRemoveParagraphStyle(codeEditor, execution_line.getValue(), "execution-line");
        if(lineIndex >= 0){
            RichTextFXHelpers.addParagraphStyle(codeEditor, lineIndex, "execution-line");
            codeEditor.moveTo(lineIndex, 0);
            codeEditor.requestFollowCaret();
        }
        execution_line.setValue(lineIndex);
    }

    /**
     * Trieda uchováva hodnotu adresy a dát v tabuľke pamäti spolu s ich reprezentáciou.
     * Poskytuje metódy na zmenu reprezentácie a zistenie, či bola hodnota dát zmenená.
     */
    public static class MemoryTableCell{
        private final SimpleStringProperty address;
        private final SimpleStringProperty data;

        private short newAddress;
        private byte newData;
        private byte oldData;

        private eRepresentation repAddress;
        private eRepresentation repData;

        /**
         * Bezparametrický konštruktor pre vytvorenie bunky s nulovou adresou a nulovou hodnotou v decimálnej sústave.
         */
        MemoryTableCell(){
            this.address = new SimpleStringProperty("0");
            this.data = new SimpleStringProperty("0");
            this.repAddress = eRepresentation.Dec;
            this.repData = eRepresentation.Dec;
        }

        /**
         * Konštruktor pre vytvorenie bunky s decimálnou reprezentáciou.
         *
         * @param address Adresa
         * @param data    Dáta na adrese
         */
        MemoryTableCell(int address, int data){
            this.address = new SimpleStringProperty(Integer.toString(address));
            this.data = new SimpleStringProperty(Integer.toString(data));
            this.repAddress = eRepresentation.Dec;
            this.repData = eRepresentation.Dec;

            newAddress = (short) address;
            newData = oldData = (byte) data;
        }

        /**
         * Konštruktor pre naplenenie hodnôt bunky aj s určenou reprezentáciou.
         *
         * @param address Adresa
         * @param data Dáta na adrese
         * @param defRepresentationAddress Reprezentácia zobrazenia adresy
         * @param defRepresentationData Reprezentácia zobrazenia dát
         */
        MemoryTableCell(int address, int data, eRepresentation defRepresentationAddress, eRepresentation defRepresentationData){
            this.address = new SimpleStringProperty(Integer.toString(address));
            this.data = new SimpleStringProperty(Integer.toString(data));
            this.repAddress = defRepresentationAddress;
            this.repData = defRepresentationData;

            newAddress = (short) address;
            newData = oldData = (byte) data;
        }

        public Property<String> addressProperty() {
            return address;
        }

        public Property<String> dataProperty() {
            return data;
        }

        /**
         * Vracia adresu uloženú v bunke ako integer.
         *
         * @return Adresa uložená v bunke.
         */
        public int getAddressInt(){
            return Short.toUnsignedInt(newAddress);
        }

        /**
         * Nastavenie adresy v bunke.
         *
         * @param address Nová adresa v bunke.
         */
        public void setAddress(short address){
            this.address.setValue(
                    getDisplayRepresentation(address, repAddress)
            );
            newAddress = address;
        }

        /**
         * Nastavenie dát v bunke.
         *
         * @param data Nové dáta v bunke.
         */
        public void setData(byte data){
            this.data.setValue(
                    getDisplayRepresentation(data, repData)
            );

            oldData = newData;
            newData = data;
        }

        /**
         * Vráti aktuálne nastavenie reprezentácie adresy.
         *
         * @return Reprezantácia adresy v bunke.
         */
        public eRepresentation getAddressRepresentation(){
            return repAddress;
        }

        /**
         * Zmena reprezentácie adresy.
         *
         * @param newRep Nová reprezentácia adresy použítá pri zobrazení.
         */
        public void changeAddressRepresentation(eRepresentation newRep){
            address.setValue( getDisplayRepresentation(newAddress, newRep) );
            repAddress = newRep;
        }

        /**
         * Vráti aktuálne nastavenie reprezentácie dát.
         *
         * @return Reprezentácia dát v bunke.
         */
        public eRepresentation getDataRepresentation(){
            return repData;
        }

        /**
         * Zmena reprezentácie dát.
         *
         * @param newRep Nová reprezentácia dát použítá pri zobrazení.
         */
        public void changeDataRepresentation(eRepresentation newRep){
            data.setValue( getDisplayRepresentation(newData, newRep) );
            repData = newRep;
        }

        /**
         * Informácia, či sa po zmene dát nové dáta líšia od starých.
         *
         * @return Ture ak sa nové dáta líšia od starých, flase inak.
         */
        public boolean isChanged(){
            return oldData != newData;
        }

    }

    /**
     * Rozširuje triedu MemoryTableCell o hodnotu pozície hlavy zásobníka.
     */
    public static class StackTableCell extends MemoryTableCell{
        private static SimpleIntegerProperty stackHead = new SimpleIntegerProperty(0);

        /**
         * Bezparametriký konštruktor, krotý volá bezparametrický konštruktor predka.
         */
        public StackTableCell(){
            super();
        }

        /**
         * Konštruktor nastavujúci adresu a dáta. Reprezentácia ostáva decimálna.
         *
         * @param address Adresa
         * @param data Dáta na adrese
         */
        public StackTableCell(int address, int data){
            super(address, data);
        }

        /**
         * Konštruktor s nastavením obsahu aj reprezentáciou.
         *
         * @param address Adrese
         * @param data Dáta na adrese
         * @param defRepresentationAddress Reprezentácia adresy.
         * @param defRepresentationData Reprezentácia dát.
         */
        public StackTableCell(int address, int data, eRepresentation defRepresentationAddress, eRepresentation defRepresentationData){
            super(address, data, defRepresentationAddress, defRepresentationData);
        }

        public static Property stackHeadProperty(){
            return stackHead;
        }

        /**
         * Nastavnie adresy, na ktorej sa nachádza vrchol zásobníka.
         *
         * @param head Adresa vrcholu zásobníka.
         */
        public static void setStackHead(int head){
            stackHead.setValue(head);
        }

        /**
         * Vrátenie adresy, na ktorej sa nachádza vrchol zásobíka.
         *
         * @return Adresa, na ktorej sa nachádza vrchol zásobníka.
         */
        public static int getStackHead(){
            return stackHead.getValue();
        }
    }


}//end CPUController