package sk.uniza.fri.cp.CPUEmul;

import javafx.application.Platform;
import javafx.beans.property.ObjectProperty;
import javafx.beans.property.Property;
import javafx.beans.property.SimpleObjectProperty;
import javafx.scene.control.Alert;
import javafx.scene.input.KeyEvent;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import sk.uniza.fri.cp.Bus.Bus;
import sk.uniza.fri.cp.CPUEmul.Exceptions.NonExistingInterruptLabelException;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.security.InvalidParameterException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Semaphore;

/**
 * Emulátor procesora použitého pri výučbe predmetu Číslicové počítače na fakulte riadenia a informatiky.
 * Pred spustením vykonávania programu je potrebné parsovaný program zaviesť.
 *
 * @author Tomáš Hianik
 * @version 1.0
 * @created 07.2.2017
 */
public class CPU extends Thread {
    //logovanie casov instrukcii
    private static Logger timesLogger;
    private long InnStart;
    private long InnEnd;
    private long ProgStart;
    private int NumOfInstr = 0;

    private final OutputStream console; //vystupny stream pre vypis znakov na terminal
    private Program program; //zavedeny program s instrukciami a konstantami programu

	/** Flagy */
    //vonkajsi pristup
    volatile private boolean isCancelled; //zrusenie vlakna
    volatile private boolean isExecuting; //spustenie/zastavenie vykonavania CPU
    volatile private boolean f_microstep; //povolenie mikrokrokovania
    volatile private boolean f_int_level; //priznak, ci je prerusenie vyvolane od urovne (ak nie tak od zmeny)
    volatile private boolean f_pause;    //pozastavenie vykonavania CPU
    //vnutorne
    private boolean f_int_level_old;    //minula uroven
    private boolean f_eit;  //priznak, ci boli v predchadzajuciej instrukcii povolene prerusenia

    private final ObjectProperty<CPUStates> state;    //status CPU
    volatile private String message; //správa cpu o vykonávaní (povodne Task, ktory mal updateMessage)

//    private int UsbITCheckSkipped = 0; //preskocenie kazdych x cyklov pred citanim IT cez USB (USB je prilis pomale)

	/** Synchronizacne nastroje */
	private CountDownLatch cdlHalt; //pasivne cakanie pri pozastaveni vykonavania alebo cakani na spustenie
    private final Semaphore semKey;   //semafor na pristup ku stlacenej klavese

	/** Registre */
	volatile private byte regA;
    volatile private byte regB;
    volatile private byte regC;
    volatile private byte regD;
    volatile private short regMP;
    volatile private short regPC;
    volatile private short regSP;
    volatile private boolean flagCY;
    volatile private boolean flagIE;
    volatile private boolean flagZ;

	/** Pamat */
    private final byte[] RAM;
    private final byte[] stack; // Zasobnik (LIFO) ma velkost podla velkosti registra SP. Pri 16bit SP je to 65536 bajtov.
    private KeyEvent key;

    /** Zbernica */
    private final Bus bus;

    public static void startTimesDebug() {
        timesLogger = LogManager.getLogger("times_CPU");
    }

    public static void stopTimesDebug() {
        timesLogger = null;
    }

    /**
     * Konštruktor prijíma OutputStream, na ktorý sa vypisujú znaky pomocou inštrukcie SCALL a zbernicu pomocou
     * ktorej komunikuje s vývojovou doskou.
     *
     * @param console OutputStream pre výpis znakov na terminál.
     * @param bus Zbernica pre komunikáciu s vývojovou doskou.
     */
	/** Spracovanie chyby pri vykonávaní inštrukcie (okrem chýbajúceho návestia prerušenia). */
	private volatile java.util.function.Consumer<String> runtimeErrorHandler;

	/**
	 * Nastavenie spracovania chyby pri vykonávaní inštrukcie. Volá sa z vlákna CPU.
	 *
	 * @param handler Prijíma správu o chybe s číslom riadku.
	 */
	public void setRuntimeErrorHandler(java.util.function.Consumer<String> handler){
		this.runtimeErrorHandler = handler;
	}

	private String describeRuntimeError(Instruction instruction, Exception e){
		int line = program == null ? -1 : program.getLineOfInstruction(program.indexOfInstruction(instruction));
		String where = line >= 0 ? "[" + (line + 1) + "] " : "";
		return where + "Chyba pri vykonávaní inštrukcie '" + instruction.getType().name() + "': " + e.getMessage();
	}

	public CPU(OutputStream console, Bus bus){
		this.console = console;

		state = new SimpleObjectProperty<>(CPUStates.Paused);

		//synchro
        this.semKey = new Semaphore(0);

		//pamat
		this.RAM = new byte[256];
		this.stack = new byte[65536];

		//zbernica
        this.bus = bus;

        this.setName("CPU_Thread");
	}

    private long startInstExeTime = 0;
    private long endInstExeTime = 0;

	/**
	 * Spustenie vykonávania vlákna.
     * Obsahuje dve slučky. Vonkajšia pre beh vlákna s CPU emulátorom a vnútorná pre beh programu.
	 */
	public void run() {

        //pokial nie je cele vlakno zrusene
        threadLoop:
        while(!isCancelled) {
            state.setValue(CPUStates.Idle);

            //cakaj na spustenie vykonavania
            while(!isExecuting){
                try {
                    haltAwait();
                } catch (InterruptedException e) {
                    //ak bolo vlakno ukoncene, opusti hlavny loop
                    if(this.isCancelled) break threadLoop;
                }
            }

            Instruction nextInstruction;
            boolean it = false; //interrupt

            state.setValue(CPUStates.Running);

            bus.setRandomAddress();
            bus.setRandomData();

            ProgStart = System.nanoTime();

            //vykonavaj pokial vlakno nebolo zrusene, je spustene vykonavanie a nie je koniec programu
            while (!isCancelled
                    && isExecuting
                    && (nextInstruction = program.getInstruction(Short.toUnsignedInt(regPC++))) != null) {

                try {
                    //kontrola nastavenia breaku v programe
                    if (program.isSetBreak(regPC - 1) || f_pause) {
                        updateMessage("Vykonávanie pozastavené");
                        state.setValue(CPUStates.Paused);
                        this.f_pause = true;
                        haltAwait();
                    }

                    state.setValue(CPUStates.Running);

                    //povolenie preruseni ak predchadzajuca instrukcia bola EIT
                    if (f_eit) {
                        flagIE = true;
                        f_eit = false;
                    }

                    // logovanie mena instrukcie
                    if (timesLogger != null) {
                        if (System.nanoTime() - ProgStart > 1000000000) {
                            ProgStart = System.nanoTime();
                            timesLogger.info("INN: {}",InnEnd - InnStart);
                            timesLogger.info("Pocet: {}",NumOfInstr);
                            NumOfInstr = 0;
                        }
                        //timesLogger.info(nextInstruction.getType().name());
                    }

                    //vykonanie instrukcie
//                    startInstExeTime = System.nanoTime();
                    execute(nextInstruction);
//                    endInstExeTime = System.nanoTime();
                    // pocitanie instrukcii
                    NumOfInstr++;

                    //kontrola vyvolania prerusenia
                    it = bus.isIT();

                    //ak je povolene prerusenie a aj vyvolane
                    if (flagIE && it) {
                        if (f_int_level) { //preusenie od urovne
                            handleInterrupt();
                        } else { //prerusenie od zmeny
                            if (!f_int_level_old) {   //ak bola nulova
                                handleInterrupt();
                            }
                        }
                    }
                    f_int_level_old = it;

                    // logovanie dlzky vykonavania instrukcie
//                    if (timesLogger != null)
//                        timesLogger.info("{} \t ns: {} \t kontrola IT: {}", nextInstruction.getType().name(), (endInstExeTime - startInstExeTime), (System.nanoTime() - endInstExeTime));
//                        timesLogger.info(nextInstruction.getType().name() + "\t ns: " + (endInstExeTime - startInstExeTime) + "\t kontrola IT: " + (System.nanoTime() - endInstExeTime));

                } catch (Exception e ) {
                    //ak doslo k vynimke

                    //ak nastala vynimka z dovodu neexistujuceho navestia prerusenia
                    if(e instanceof NonExistingInterruptLabelException) {
                        Platform.runLater(()->{
                            Alert alert = new Alert(Alert.AlertType.ERROR);
                            alert.setTitle("Chyba");
                            alert.setContentText(e.getMessage());
                            alert.setHeaderText("Chyba prerušenia");
                            alert.show();
                        });
                    } else if (runtimeErrorHandler != null) {
                        //ina chyba pri vykonavani - program sa zastavi, ale nie potichu
                        runtimeErrorHandler.accept(describeRuntimeError(nextInstruction, e));
                    }

                    this.isExecuting = false;
                }
            }
            this.isExecuting = false;
        }
        System.out.println("CPU koniec");

	}

    /**
     * Začatie vykonávania programu, ak je zavedený.
     */
    public void startExecute(boolean startPaused){
        if(!this.isExecuting && this.program != null) {
            this.regPC = 0;
            this.isExecuting = true;
            this.f_pause = startPaused;
            if (this.cdlHalt != null) cdlHalt.countDown();
        }
    }

    /**
     * Pozastavenie vykonávania CPU.
     */
    public void pauseExecute(){
        f_pause = true;
    }


    /**
     * Pokračovanie vo vykonávaní programu, ak bolo pozastavené.
     */
    public void continueExecute(){
        if(this.f_pause) {
            f_pause = false;
            if (cdlHalt != null) cdlHalt.countDown();
        }
	}

	/**
     * Skok na ďalšiu inštrukciu v programe.
     */
    public void step(){
        f_pause = true; //pri krokovani zastavit pred vykonanim dalsej inst.
        if (cdlHalt != null) cdlHalt.countDown();
    }

    /**
     * Ukončenie vykonávania zavedeného programu.
     */
    public void stopExecute(){
        if(this.isExecuting) {
            this.isExecuting = false;
            if(this.cdlHalt != null) cdlHalt.countDown();
            else interrupt();
        }
    }

    /**
     * Ukončenie vykonávania vlákna s CPU.
     */
    public void cancel(){
        this.isCancelled = true;
        //if(this.cdlHalt != null) this.cdlHalt.countDown();
        interrupt();
	}

    /**
     * Resetovanie stavu CPU.
     * Prístup k pamäti RAM a Stack nie je synchronizovaný, preto dávajte pozor, aby ste stav CPU resetovali
     * iba mimo jeho aktívneho stavu.
     */
    public void reset(){
        regA = regB = regC = regD = 0;
        regMP = regPC = regSP = 0;
        flagCY = flagIE = flagZ = false;

        synchronized (this.RAM) {
            for (int i = 0; i < RAM.length; i++) RAM[i] = 0;
        }
        synchronized (this.stack) {
            for (int i = 0; i < stack.length; i++) stack[i] = 0;
        }

        if (semKey.availablePermits() > 0)
            semKey.drainPermits();
    }

    /**
     * Zavedenie nového programu určeného na vykonávanie.
     * @param programToLoad Program, ktorý ma CPU vykonávať.
     */
    public void loadProgram(Program programToLoad){
        this.program = programToLoad;
    }

    /**
     * Vráti hodnotu všeobecného registra A.
     * @return Aktuálna hodnota registra A.
     */
    public byte getRegA() {
        return regA;
    }

    /**
     * Vráti hodnotu všeobecného registra B.
     * @return Aktuálna hodnota registra B.
     */
    public byte getRegB() {
		return regB;
	}

    /**
     * Vráti hodnotu všeobecného registra C.
     * @return Aktuálna hodnota registra C.
     */
    public byte getRegC() {
		return regC;
	}

    /**
     * Vráti hodnotu všeobecného registra D.
     * @return Aktuálna hodnota registra D.
     */
    public byte getRegD() {
		return regD;
	}

    /**
     * Vráti hodnotu registra ukazujúceho na pamäť.
     * @return Aktuálna hodnota registra MP.
     */
    public short getRegMP() {
		return regMP;
	}

    /**
     * Vráti hodnotu registra obsahujúceho adresu nasledujúcej inštrukcie.
     * @return Aktuálna hodnota registra PC.
     */
    public short getRegPC() {
        return regPC;
    }

    /**
     * Vráti hodnotu registra ukazujúceho na vrchol zásobníka.
     * @return Aktuálna hodnota registra SP.
     */
    public short getRegSP() {
		return regSP;
	}

    /**
     * Vráti príznak Carry.
     * @return Aktuálna hodnota príznaku Carry.
     */
    public boolean isFlagCY() {
        return flagCY;
    }

    /**
     * Vráti príznak interruption enable.
     * @return Aktuálna hodnota príznaku IE.
     */
    public boolean isFlagIE() {
        return flagIE;
    }

    /**
     * Vráti príznak Zero.
     * @return Aktuálna hodnota príznaku Zero.
     */
    public boolean isFlagZ() {
        return flagZ;
    }

    /**
     * Vráti obsah špeciálnej pamäte procesora.
     * @return Obsah pamäte.
     */
    public byte[] getRAM() {
        synchronized (this.RAM) {
            return RAM.clone();
        }
	}

    /**
     * Vráti obsah zásobníka.
     * @return Obsah zásobníka.
     */
    public byte[] getStack() {
        synchronized (this.stack) {
            return stack.clone();
        }
	}

    /**
     * Nastavenie stlačenej klávesy pre inštrukciu scall.
     * @param event Event vyvolaný stlačenou klávesou.
     */
    public void setKeyPressed(KeyEvent event){
        synchronized (this){
            this.key = event;
        }

        if(semKey.availablePermits() == 0)
            semKey.release();
    }

    /**
     * Nastavenie spôsobu vyvolania prerušenia.
     * @param intByLevel True - prerušenie podľa úrovne, false - prerušenie od zmeny
     */
    public void setIntLevel(boolean intByLevel){
        this.f_int_level = intByLevel;
    }

    /**
     * Povolenie alebo zakázanie mikrokrokovania.
     * @param value True ak má byť mikrokrokovanie povolené, false ak má byť zakázané.
     */
    public void setMicrostep(boolean value){
        this.f_microstep = value;
    }

    public Property<CPUStates> stateProperty(){
        return state;
    }

    /**
     * Správa o stave, v ktorom sa procesor nachádza.
     *
     * @return Správa o stave procesora.
     */
    public String getMessage(){
        return this.message;
    }

    /**
     * Vykonanie konkretnej instrukcie
     */
    private void execute(Instruction instruction) throws InterruptedException {
        int Rd;
        int Rs;
        int K;
        short addr;

        switch (instruction.getType()){
            case ADD:
                Rd = getRegisterVal(instruction.getFirstParameter());
                Rs = getRegisterVal(instruction.getSecondParameter());
                Rd += Rs;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                flagCY = (Rd > 255);
                break;
            case ADC:
                Rd = getRegisterVal(instruction.getFirstParameter());
                Rs = getRegisterVal(instruction.getSecondParameter());
                Rd += Rs + (flagCY?1:0);
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                flagCY = (Rd > 255);
                break;
            case ADI:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Parser.parseConstant(instruction.getSecondParameter());
                Rd += K;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                flagCY = (Rd > 255);
                break;
            case SUB:
                Rd = getRegisterVal(instruction.getFirstParameter());
                Rs = getRegisterVal(instruction.getSecondParameter());
                Rd -= Rs;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                flagCY = (Rd < 0);
                break;
            case SUC:
                Rd = getRegisterVal(instruction.getFirstParameter());
                Rs = getRegisterVal(instruction.getSecondParameter());
                Rd -= Rs + (flagCY?1:0);
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                flagCY = (Rd < 0);
                break;
            case SBI:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Parser.parseConstant(instruction.getSecondParameter());
                Rd -= K;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                flagCY = (Rd < 0);
                break;
            case AND:
                Rd = getRegisterVal(instruction.getFirstParameter());
                Rs = getRegisterVal(instruction.getSecondParameter());
                Rd &= Rs;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = (Rd == 0);
                break;
            case ANI:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Parser.parseConstant(instruction.getSecondParameter());
                Rd &= K;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = (Rd == 0);
                break;
            case ORR:
                Rd = getRegisterVal(instruction.getFirstParameter());
                Rs = getRegisterVal(instruction.getSecondParameter());
                Rd |= Rs;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = (Rd == 0);
                break;
            case ORI:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Parser.parseConstant(instruction.getSecondParameter());
                Rd |= K;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = (Rd == 0);
                break;
            case XOR:
                Rd = getRegisterVal(instruction.getFirstParameter());
                Rs = getRegisterVal(instruction.getSecondParameter());
                Rd ^= Rs;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = (Rd == 0);
                break;
            case XRI:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Parser.parseConstant(instruction.getSecondParameter());
                Rd ^= K;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = (Rd == 0);
                break;
            case INC:
                Rd = getRegisterVal(instruction.getFirstParameter());
                setRegisterVal(instruction.getFirstParameter(), ++Rd);
                flagCY = flagZ = ((Rd & 0xFF) == 0);
                break;
            case INX:
                Rd = getRegisterVal(instruction.getFirstParameter());
                setRegisterVal(instruction.getFirstParameter(), ++Rd);
                flagCY = flagZ = ((Rd & 0xFFFF) == 0);
                break;
            case DEC:
                Rd = getRegisterVal(instruction.getFirstParameter());
                flagCY = ((Rd & 0xFF) == 0);
                setRegisterVal(instruction.getFirstParameter(), --Rd);
                flagZ = ((Rd & 0xFF) == 0);
                break;
            case DCX:
                Rd = getRegisterVal(instruction.getFirstParameter());
                flagCY = ((Rd & 0xFFFF) == 0);
                setRegisterVal(instruction.getFirstParameter(), --Rd);
                flagZ = ((Rd & 0xFFFF) == 0);
                break;
            case CMP:
                Rd = getRegisterVal(instruction.getFirstParameter());
                Rs = getRegisterVal(instruction.getSecondParameter());
                flagZ = ((Rd - Rs) == 0);
                flagCY = ((Rd - Rs) < 0);
                break;
            case CMI:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Parser.parseConstant(instruction.getSecondParameter());
                flagZ = ((Rd - K) == 0);
                flagCY = ((Rd - K) < 0);
                break;
            //posun a rotacia
            case SHL:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Integer.parseInt(instruction.getSecondParameter());
                Rd <<= K;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                break;
            case SHR:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Integer.parseInt(instruction.getSecondParameter());
                Rd >>= K;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                break;
            case SCR:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Integer.parseInt(instruction.getSecondParameter());
                flagCY = ((Rd & (1<<(K-1))) != 0);
                Rd >>= K;
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                break;
            case RTL:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Integer.parseInt(instruction.getSecondParameter());
                Rd = (Rd << K) | (Rd >> (8-K));
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                break;
            case RCL:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Integer.parseInt(instruction.getSecondParameter());
                Rd = (Rd << K) | (Rd >> (8-K));
                flagCY = ((Rd & 1) == 1);
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                break;
            case RTR:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Integer.parseInt(instruction.getSecondParameter());
                Rd = (Rd >> K) | (Rd << (8-K));
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                break;
            case RCR:
                Rd = getRegisterVal(instruction.getFirstParameter());
                K = Integer.parseInt(instruction.getSecondParameter());
                Rd = (Rd >> K) | (Rd << (8-K));
                flagCY = ((Rd & 0x80) != 0);
                setRegisterVal(instruction.getFirstParameter(), Rd);
                flagZ = ((Rd & 0xFF) == 0);
                break;
            case MOV:
                setRegisterVal(instruction.getFirstParameter(), getRegisterVal(instruction.getSecondParameter()));
                break;
            case MVI:
            case MXI:
                setRegisterVal(instruction.getFirstParameter(), Parser.parseConstant( instruction.getSecondParameter() ));
                break;
            case MVX:
                if(instruction.getFirstParameter().toUpperCase().equals("C")){
                    Rs = getRegisterVal(instruction.getSecondParameter());
                    int L = Rs & 0xFF;
                    int H = Rs >> 8;
                    setRegisterVal("C", H);
                    setRegisterVal("D", L);
                } else {
                    int val = getRegisterVal("B") * 256 | getRegisterVal("A");
                    setRegisterVal(instruction.getFirstParameter(), val);
                }
                break;
            case MMR:
                Rs = getRegisterVal(instruction.getSecondParameter());
                setRegisterVal(instruction.getFirstParameter(), program.getByte(Rs));
                break;
            case LMI:   //nacitanie pamate do registra s puzitim priamej adresy
                addr = (short) Parser.parseConstant(instruction.getSecondParameter());
                read(enumInstructionsSet.LMI, addr, instruction.getFirstParameter());
                break;
            case LMR:   //nacitanie pamate do registra s puzitim adresy v reg MP
                read(enumInstructionsSet.LMR, regMP, instruction.getFirstParameter());
                break;
            case SMI:
                addr = (short) Parser.parseConstant(instruction.getFirstParameter());
                write(enumInstructionsSet.SMI, addr, (byte) getRegisterVal(instruction.getSecondParameter()));
                break;
            case SMR:
                write(enumInstructionsSet.SMR, regMP, (byte) getRegisterVal(instruction.getFirstParameter()));
                break;
            case INN:
                addr = (short) Parser.parseConstant(instruction.getSecondParameter());
                read(enumInstructionsSet.INN, addr, instruction.getFirstParameter());
                break;
            case OUT:
                addr = (short) Parser.parseConstant(instruction.getFirstParameter());
                write(enumInstructionsSet.OUT, addr, (byte) getRegisterVal(instruction.getSecondParameter()));
                break;
            case PUS:
                if (instruction.getFirstParameter().matches("(?i)M")) {
                    push((short) getRegisterVal(instruction.getFirstParameter()));
                } else if (instruction.getFirstParameter().matches("(?i)F")) {
                    push(getFlagsByte());
                } else {
                    push((byte) getRegisterVal(instruction.getFirstParameter()));
                }
                break;
            case POP:
                if (instruction.getFirstParameter().matches("(?i)M")) {
                    setRegisterVal(instruction.getFirstParameter(), popShort());
                } else if (instruction.getFirstParameter().matches("(?i)F")) {
                    setFlagsByte(pop());
                } else {
                    setRegisterVal(instruction.getFirstParameter(), pop());
                }
                break;
            case STR:
                Rd = getRegisterVal(instruction.getFirstParameter());
                Rs = getRegisterVal(instruction.getSecondParameter());
                synchronized (this) {
                    RAM[Rd] = (byte) Rs;
                }
                break;
            case LDR:
                Rs = getRegisterVal(instruction.getSecondParameter());
                setRegisterVal(instruction.getFirstParameter(), RAM[Rs]);
                break;
            //Instrukcie vetvenia
            case JMP:
                regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                break;
            case JE:
            case JZR:
                if(flagZ) regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                break;
            case JNE:
            case JNZ:
                if(!flagZ) regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                break;
            case JL:
            case JCY:
                if(flagCY) regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                break;
            case JNL:
            case JGE:
            case JNC:
                if(!flagCY) regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                break;
            case JG:
                if((!flagCY)&&(!flagZ)) regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                break;
            case JNG:
            case JLE:
                if(flagCY||flagZ) regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                break;
            case CAL:
                push(regPC);
                regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                break;
            case CE:
            case CZR:
                if(flagZ) {
                    push(regPC);
                    regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                }
                break;
            case CNE:
            case CNZ:
                if(!flagZ) {
                    push(regPC);
                    regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                }
                break;
            case CL:
            case CCY:
                if(flagCY) {
                    push(regPC);
                    regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                }
                break;
            case CNL:
            case CGE:
            case CNC:
                if(!flagCY) {
                    push(regPC);
                    regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                }
                break;
            case CG:
                if((!flagCY)&&(!flagZ)) {
                    push(regPC);
                    regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                }
                break;
            case CNG:
            case CLE:
                if(flagCY||flagZ) {
                    push(regPC);
                    regPC = (short) Integer.parseUnsignedInt(instruction.getFirstParameter());
                }
                break;
            case RET:
                regPC = popShort();
                break;
            //Specialne instrukcie
            case EIT:
                f_eit = true;
                break;
            case DIT:
                flagIE = false;
                break;
            case SCALL:
                switch(instruction.getFirstParameter().toUpperCase()){
                    case "KEY":
                        if(!semKey.tryAcquire()){
                            //cakanie na stlacenie klavesy
                            updateMessage("Stlacte klavesu");
                            state.setValue(CPUStates.Waiting);
                            semKey.acquire();
                            state.setValue(CPUStates.Running);
                        }

                        synchronized (this) {
                            if (key.getCode().isArrowKey())
                                setRegisterVal("d", key.getCode().impl_getCode());
                            else
                                setRegisterVal("d", key.getCharacter().charAt(0));
                        }

                        break;
                    case "KPR":
                        flagCY = semKey.availablePermits() > 0;
                        break;
                    case "DSP":
                        try {
                            console.write(regD);
                        } catch (IOException e) {
                            e.printStackTrace();
                        }
                        break;
                    default:
                }
                break;
        }
    }

    /**
     * Obsluha hw prerušenia ak nastalo.
     *
     * @throws NonExistingInterruptLabelException Výnimka, ak neexistuje načítané číslo prerušenia.
     */
    private void handleInterrupt() throws NonExistingInterruptLabelException {
        //vypnutie preruseni
        flagIE = false;

        //synchronizovane citanie
//        LOGGER.debug("IA_ LOW");
//        System.out.println("IA_ LOW");
        bus.setIA_(false);
//        LOGGER.debug("IA_ Cakanie na steady state");
        this.waitForSteadySimulation(null, true);
//        LOGGER.debug("IA_ Nacitanie dat");
        byte data = bus.getDataBus();
//        LOGGER.debug("IA_ Nacitane " + Byte.toUnsignedInt(data));
//        System.out.println(("IA_ Nacitane " + Byte.toUnsignedInt(data)));
        bus.setIA_(true);
//        LOGGER.debug("IA_ HIGH");
//        System.out.println("IA_ HIGH");

        //odlozenie PC na zasobnik
        push(regPC);

        //nastavenie adresy instrukcie prerusenia
        int intNumber = data & 0x0f;
//        System.out.println("IA_ Nacitane " + intNumber);
        regPC = (short) program.getAddressOfInterrupt(intNumber);
    }

    /**
     * Vrátenie hodnoty registra na základe názvu registra.
     *
     * @param regName Názov registra.
     * @return Hodnota uložená v registri.
     */
    private int getRegisterVal(String regName){
        switch (regName.toUpperCase()){
            case "A": return Byte.toUnsignedInt(regA);
            case "B": return Byte.toUnsignedInt(regB);
            case "C": return Byte.toUnsignedInt(regC);
            case "D": return Byte.toUnsignedInt(regD);
            case "M": return Short.toUnsignedInt(regMP);
            case "S": return Short.toUnsignedInt(regSP);
            case "PC": return Short.toUnsignedInt(regPC);
        }
        throw new InvalidParameterException("Neplatny register");
    }

    /**
     * Nastavenie hodnoty registra na základe názvu registra.
     *
     * @param regName Názov registra.
     * @param value Nová hodnota, ktorá má byť uložená do registra. Ak je väčšia ako register, oreže sa.
     */
    private void setRegisterVal(String regName, int value){
        switch (regName.toUpperCase()){
            case "A": regA = (byte) value; break;
            case "B": regB = (byte) value; break;
            case "C": regC = (byte) value; break;
            case "D": regD = (byte) value; break;
            case "M": regMP = (short) value; break;
            case "S": regSP = (short) value; break;
            case "PC": regPC = (short) value; break;
            default: throw new InvalidParameterException("Neplatny register");
        }
    }

    /**
     * Register F pre PUS F / POP F: bit0 = CY, bit1 = Z, bit2 = IE, ostatné bity sú 0.
     *
     * @return Príznaky zbalené do bajtu.
     */
    private byte getFlagsByte(){
        return (byte) ((flagCY ? 1 : 0) | (flagZ ? 2 : 0) | (flagIE ? 4 : 0));
    }

    /**
     * Nastavenie príznakov CY, Z a IE z registra F (POP F).
     *
     * @param value Bajt s príznakmi (bit0 = CY, bit1 = Z, bit2 = IE).
     */
    private void setFlagsByte(byte value){
        flagCY = (value & 1) != 0;
        flagZ = (value & 2) != 0;
        flagIE = (value & 4) != 0;
    }

    /**
     * Pridanie hodnoty typu byte na vrchol zásobníka s aktualizáciou registra SP.
     *
     * @param value Hodnota, ktorá sa pridá na vrchol zásobníka.
     */
    private void push(byte value){
        int SP = Short.toUnsignedInt(this.regSP);
        synchronized (this.stack) {
            this.stack[SP--] = value;
        }
        this.regSP = (short) SP;
    }

    /**
     * Pridanie hodnoty typu short na vrchol zásobníka s aktualizáciou registra SP.
     * Ako prvý sa uloží horný bajt, až potom spodný bajt.
     *
     * @param value Hodnota, ktorá sa pridá na vrchol zásobníka.
     */
    private void push(short value){
        int L = value & 0xFF;
        int H = value >> 8 & 0xFF;
        push((byte)H);
        push((byte)L);
    }

    /**
     * Výber hodnoty typu byte z vrcholu zásobíka s aktualizáciou registra SP.
     *
     * @return Hodnota na vrchole zásobníka.
     */
    private byte pop(){
        int SP = Short.toUnsignedInt(this.regSP);
        if(SP == 65535) SP = 0;
        else SP++;
        this.regSP = (short) SP;
        return this.stack[SP];
    }

    /**
     * Výber hodnoty typu short z vrcholu zásobíka s aktualizáciou registra SP.
     * Pre výber hodnoty typu short sa spoja dve hodnoty z vrcholu zásobníka, spodný bajt sa zoberie ako prvý,
     * vrchý bajt ako druhý.
     *
     * @return Hodnota na vrchole zásobníka.
     */
    private short popShort(){
        int L = Byte.toUnsignedInt(pop());
        int H = Byte.toUnsignedInt(pop())<<8;
        return (short) (H|L);
    }

    /**
     * Metóda zaobstaravajúca čítanie z externého zariadenia pripojeného k vývojovej doske.
     *
     * @param inst Inštrukcia, ktorá vyvolala čítanie
     * @param addr Adresa, z ktorej sa má čítať
     * @param destRegName Názov reigstra, kam sa má načítaná hodnota uložiť
     * @throws InterruptedException Prerušenie počas synchrónnej komunikácie alebo mikrokrokovania
     */
    private void read(enumInstructionsSet inst, short addr, String destRegName) throws InterruptedException {
        InnStart = System.nanoTime();
        //nastavenie adresy
        microstepAwait("Nastavenie adresy");
        bus.setAddressBus(addr);

        microstepAwait("Nastavenie priznaku " + (inst == enumInstructionsSet.INN?"IOR":"MR") + " = 0");

        //nastavenie priznaku citania
        if (inst == enumInstructionsSet.INN)
            bus.setIR_(false);
        else
            bus.setMR_(false);

        //cakanie na nastavenie dat na datovej zbernici
        //updateMessage("Cakanie na nastavenie dat");
        this.waitForSteadySimulation(inst, true);
        if (!isExecuting) throw new InterruptedException("CPU stopped");

        //nacitaj data
        microstepAwait("Nacitanie dat");
        byte Rd = bus.getDataBus();
        setRegisterVal(destRegName, Rd);

        //zrus priznak citania
        microstepAwait("Zrusenie priznaku " + (inst == enumInstructionsSet.INN?"IOR":"MR"));
        if(inst == enumInstructionsSet.INN)
            bus.setIR_(true);
        else
            bus.setMR_(true);
        // nahodne data
        bus.setRandomData();

        //zrus adresu
        microstepAwait("Zrusenie adresy");
        bus.setRandomAddress();
        InnEnd = System.nanoTime();
    }

    /**
     * Metóda zaobstaravajúca zápis do externého zariadenia pripojeného k vývojovej doske
     *
     * @param inst Inštrukcia, ktorá vyvolala zápis
     * @param addr Adresa, na ktorú sa má zapisovať
     * @param data Dáta, ktoré sa majú na adresu zapísať
     * @throws InterruptedException Prerušenie počas sycnhrónneho zápisu alebo čakania pri mikrokrokovaní
     */
    private void write(enumInstructionsSet inst, short addr, byte data) throws InterruptedException {
        //nastavenie adresy
        microstepAwait("Nastavenie adresy");
        bus.setAddressBus(addr);

        //nastavenie dat
        microstepAwait("Nastavenie dat");
        bus.setDataBus(data);

        //nastavenie priznaku
        microstepAwait("Nastavenie priznaku " + (inst == enumInstructionsSet.OUT?"IOW":"MW") + " = 0");

        //nastavenie priznaku
        if (inst == enumInstructionsSet.OUT)
            bus.setIW_(false);
        else
            bus.setMW_(false);

        //updateMessage("Cakanie na nastavenie dat");
        this.waitForSteadySimulation(inst, true);
        if (!isExecuting) throw new InterruptedException("CPU stopped");

        //zrusenie priznaku
        microstepAwait("Zrusenie priznaku ZAPISU");
        if(inst == enumInstructionsSet.OUT)
            bus.setIW_(true);
        else
            bus.setMW_(true);

        //cakanie, aby sa nezapisali nespravne data
        this.waitForSteadySimulation(inst, false);
        if (!isExecuting) throw new InterruptedException("CPU stopped");

        //zrusenie dat
        microstepAwait("Zrusenie dat");
        bus.setRandomData();

        //zrusenie adresy
        microstepAwait("Zrusenie adresy");
        bus.setRandomAddress();
    }

    /**
     * Ak je zapnuté mikrokrokovanie, metóda aktualizuje správu CPU, stav a pozastaví vykonávanie.
     *
     * @param msg Telo správy pre stavový riadok.
     * @throws InterruptedException Výnimka pri prerušení počas čakania na pokračovanie vykonávania.
     */
    private void microstepAwait(String msg) throws InterruptedException {
        //ak je zapnute mikrokrokovanie a zaroven sa aj krokuje
        if (isExecuting && f_microstep && f_pause) {
            updateMessage(msg);
            state.setValue(CPUStates.Paused);
            haltAwait();
            state.setValue(CPUStates.Running);
        }
    }

    /**
     * Pasívne čakanie pri pozastavení vykonávania.
     *
     * @throws InterruptedException Prerušenie počas čakania
     */
    private void haltAwait() throws InterruptedException {
        cdlHalt = new CountDownLatch(1);
        cdlHalt.await();
        cdlHalt = null;
    }

    private long lastErrorMsgPrint = 0;

    /**
     * Pasívne čakanie na nastavenie dát na dátovej zbernici pre ich čítanie.
     *
     * @param inst Inštrukcia, ktorá požaduje čítanie. Null ak sa jedná o IT.
     * @param showConsoleMsg True ak sa má zobraziť chybová správa v konzole, false ak nie.
     */
    private void waitForSteadySimulation(enumInstructionsSet inst, boolean showConsoleMsg) {
        try {
            if (!bus.waitForSteadyState() && isExecuting) {
                //data nie su nastavene (simulator nebezi alebo nie je 5 sekund na nastavenie dat dostacujucich)
                if (System.currentTimeMillis() - lastErrorMsgPrint > 2000) {
                    console.write(
                            ("Pozor! Chyba zbernice. Spustite prosim simulaciu a usisite sa, ze nedochadza k zacykleniu. ")
                            .getBytes(Charset.forName("UTF-8")));
                    console.write(10);
                    console.write(13);
                    lastErrorMsgPrint = System.currentTimeMillis();
                }
            }
        } catch (IOException e) {
            //e.printStackTrace();
        }
    }

    /**
     * Aktualizácia správy procesora okoliu.
     * @param msg Nová správa
     */
    private void updateMessage(String msg){
        this.message = msg;
    }

}//end CPU