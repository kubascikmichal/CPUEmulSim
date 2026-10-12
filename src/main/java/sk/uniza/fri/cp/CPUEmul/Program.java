package sk.uniza.fri.cp.CPUEmul;

import javafx.collections.ObservableSet;
import javafx.collections.SetChangeListener;
import org.apache.commons.lang3.ArrayUtils;
import sk.uniza.fri.cp.CPUEmul.Exceptions.NonExistingInterruptLabelException;

import java.util.*;

/**
 * Trieda pre uchovanie inštrukcií programu, návestí a breakov.
 *
 * @author Tomáš Hianik
 * @version 1.0
 * @created 07-feb-2017 18:40:27
 */
public class Program {

	/**
	 * indexy instrukcii na ktorych je break
	 */
	private TreeSet<Integer> breaks;

	/**
	 * navestia pre riadenie preruseni... nemozu sa opakovat
	 */
	private TreeMap<Integer, Integer> interruptionLabels; //<cislo prerusenia 0-15, adresa nasledujucej instrukcie>

	/**
	 * prevodnik medzi riadkom v editore a indexom instrukcie v programe pre
	 * zachytenie breaku
	 * <riadok, index instrukcie>
	 */
	private TreeMap<Integer, Integer> lineIndexToInstructionIndex;
	private ArrayList<Byte> memory; //pamäť programu pre konštanty zadane pomocou pseudoinštrukcie BYTE
	private ArrayList<Instruction> instructions; //inštrukcie programu

	private SetChangeListener breakpointsListener; //listener na zmenu v zozname breakpointov

    private boolean hasIOInstruction; //obsahuje program instrukcie komunikujuce cez zbernicu s doskou?

    /**
     * Konštruktor pre spojenie inštrukcií, konštánt a návestí z ktorých je zložený program pre CPU.
     *
     * @param instructions Zoznam inštrukcií v arrayListe, ktorých index je adresa pre CPU.
     * @param memory ArrayList konštánt programu.
     * @param lineIndexToInstructionIndex Prevodník medzi indexom riadku na ktorom je inštrukcia a adresou inštrukcie.
     * @param interruptionLabels Mapa návestí prerušení, kde kľúčom je číslo návestia a hodnotou adresa nasledujúcej inštrukcie.
     */
	Program(ArrayList<Instruction> instructions, ArrayList<Byte> memory, TreeMap<Integer, Integer> lineIndexToInstructionIndex, TreeMap<Integer, Integer> interruptionLabels){
        this.instructions = instructions;
        this.memory = memory;
        this.lineIndexToInstructionIndex = lineIndexToInstructionIndex;
        this.interruptionLabels = interruptionLabels;

        this.breaks = new TreeSet<>();

        for (Instruction inst : instructions) {
            switch (inst.getType()) {
                case LMI:
                case LMR:
                case SMI:
                case SMR:
                case INN:
                case OUT:
                case EIT:
                    hasIOInstruction = true;
                    break;
                default:
                    break;
            }
            if (hasIOInstruction) break;
        }
    }

    /**
     * Obsahuje program inštrukcie pre komunikáciu cez zbernicu s doskou?
     *
     * @return True ak obsahuje aspon jednu, false inak
     */
    public boolean hasIOInstruction() {
        return hasIOInstruction;
    }

	/**
	 * Metóda zavádza listenera na zmenu v breakpointoch, ktoré prevádza na indexy inštrukcii v členskom liste triedy.
     *
	 * @param obsBreakIndexes Zoznam s indexami riadkov, na ktorých je zavedený breakpoint.
	 */
	public void setListenerOnBreakpointsChange(ObservableSet<Integer> obsBreakIndexes){
		//vycistenie zoznamu
		breaks.clear();
		//pridanie vsetkych aktualnych breakpointov
		obsBreakIndexes.forEach(index ->
				breaks.add(lineIndexToInstructionIndex.get(index)));

		breakpointsListener = (change) -> {
		    synchronized (this) { //FXThread meni, CPU cita
                breaks.clear();
                obsBreakIndexes.stream().filter((index) -> index >= 0).forEach(index ->
                        breaks.add(lineIndexToInstructionIndex.get(index)));
            }
        };

		//registracia listenera na zmenu v breakpointoch
		obsBreakIndexes.addListener(breakpointsListener);
	}

    /**
     * Odobratie listenera na zmenu v breakpointoch.
     *
     * @param obsBreakIndexes Zoznam od ktorého sa má program odpojiť.
     */
	public void removeListenerOnBreakpointsChange(ObservableSet<Integer> obsBreakIndexes){
		if(breakpointsListener != null)
			obsBreakIndexes.removeListener(breakpointsListener);
	}

    /**
     * Hľadá a vracia riadok inštrukcie na základe jej adresy.
     *
     * @param instructionAddress Index inštrukcie, ku ktorej sa hľadá riadok.
     * @return Index riadku, na ktorom je inštrukcia, ak sa nenašla, vracia -1.
     */
    public int getLineOfInstruction(int instructionAddress){
        for (Map.Entry<Integer, Integer> entry : lineIndexToInstructionIndex.entrySet()) {
            if (Objects.equals(instructionAddress, entry.getValue())) {
                return entry.getKey();
            }
        }
        return -1;
    }

    /**
     * Vracia pole bajtov uložených ako konštanty programu.
     *
     * @return Pole konštánt programu.
     */
    public byte[] getMemory(){
        return ArrayUtils.toPrimitive( memory.toArray(new Byte[0]) );
    }

    /**
     * Vrcia bajt na adrese v pamäti programu
     *
     * @param address Adresa bajtu v pamäťi programu
     * @return Bajt uložený na danej adrese
     */
    byte getByte(int address){
        if(address > memory.size()-1) return 0;
        return memory.get(address);
    }

    /**
     * Vracia inštrukciu na adrese (indexe) ak taká existuje, ak nie vracia null.
     *
     * @param address Adresa inštrukcie v pämati (index inštrukcie)
     * @return Inštrukcia na adrese alebo null
     */
	/**
	 * Adresa danej inštrukcie v programe.
	 *
	 * @param instruction Inštrukcia programu
	 * @return Index inštrukcie, alebo -1 ak nie je v programe
	 */
	int indexOfInstruction(Instruction instruction){
		return instructions.indexOf(instruction);
	}

	Instruction getInstruction(int address){
		try {
			return instructions.get(address);
		} catch (IndexOutOfBoundsException e){
			return null;
		}
	}

    /**
     * Zisťuje, či je na danej adrese nastavený breakpoint.
     *
     * @param instructionAddress Adresa inštrukcie.
     * @return True ak je na danej adrese nastavený breakpoint, false inak.
     */
	boolean isSetBreak(int instructionAddress){
        synchronized (this) {
            return breaks.contains(instructionAddress);
        }
    }

    /**
     * Vracia adresu inštrukcie na ktorú ukazuje prerušenie s daným číslom.
     *
     * @param intNumber Číslo prerušenia.
     * @return Adresa inštrukcie na ktorú prerušenie ukazuje (ktorá nasleduje bezprostredne za prerušením).
     * @throws NonExistingInterruptLabelException Výnimka, ak také číslo prerušenia nie je v programe uvedené.
     */
	int getAddressOfInterrupt(int intNumber) throws NonExistingInterruptLabelException {
	    if(interruptionLabels.containsKey(intNumber)){
	        return interruptionLabels.get(intNumber);
        } else {
            throw new NonExistingInterruptLabelException(intNumber);
        }
	}
}