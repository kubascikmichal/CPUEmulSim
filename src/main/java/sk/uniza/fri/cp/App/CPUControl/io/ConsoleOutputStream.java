package sk.uniza.fri.cp.App.CPUControl.io;

import javafx.application.Platform;
import org.fxmisc.richtext.InlineCssTextArea;

import java.io.IOException;
import java.io.OutputStream;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Semaphore;

/**
 * Výstupný stream ako obal pre CPU konzolu aka. InlineCssTextArea.
 *
 * @author Tomáš Hianik
 * @created  8.2.2017.
 * @version 0.3
 */
public class ConsoleOutputStream extends OutputStream {

    private InlineCssTextArea console;
    private String color;
    private boolean isUsed; //indikator, ci bol vypis od posledneho nastavenia pouzity

    /**
     * Vytvorenie výstupého streamu nad InlineCssTextArea.
     *
     * @param console Konzola, do ktorej sa bude presmerovávať výstup.
     */
    public ConsoleOutputStream(InlineCssTextArea console){
        this.console = console;
        this.color = "black";
    }

    /**
     * Vytvorenie výstupného streamu nad InlineCssTextArea s určenou farbou písma.
     *
     * @param console Konzola, do ktorej sa bude presmerovávať výstup.
     * @param color Farba písama.
     */
    public ConsoleOutputStream(InlineCssTextArea console, String color){
        this.console = console;
        this.color = color;
    }

    /**
     * Bol už tento stream od poseldného nastavenia použitý?
     * Používa sa pri výpise na konzolu pred a po spustení CPU, aby sa zistilo či niečo vypísal.
     *
     * @return Truea ak bol použitý, false inak.
     */
    public boolean isUsed(){ return isUsed; }

    /**
     * Nastavenie, že stream ešte nebol použitý. Pred spustením vykonávania programu na CPU.
     */
    public void setUnused(){ this.isUsed = false; }

    /**
     * Výpis znaku na koznolu.
     * Ak sa jedná o prvý znak, vypíše sa najprv reťazec [CPU KONZOLA].
     *
     * @param b Znak, ktorý sa má vypísať na konzolu.
     */
    private void writeToConsole(int b){
        if(!isUsed) {
            if (console.getParagraph(console.getCurrentParagraph()).getText().length() > 0)
                console.appendText("\n");
            console.setStyle(console.getCurrentParagraph(), "-fx-fill: red");
            console.appendText("[CPU KONZOLA]\n");
            isUsed = true;
        }

        int paragraph = console.getCurrentParagraph();
        if( b == 10) { //LF - novy riadok, rovnaka pozicia
            int caretCol = console.getCaretColumn();
            console.appendText("\n");
            if (caretCol > 0)
                console.appendText(String.format("%" + caretCol + "s", ""));
        } else if( b == 13) { //CR - vratenie na zaciatok riadku
            console.moveTo(console.getCurrentParagraph(), 0);
        } else {
            int pos = console.getCaretPosition();
            if (pos == console.getLength())
                console.replaceText(pos, pos, String.valueOf((char) b));
            else
                console.replaceText(pos, pos + 1, String.valueOf((char) b));
        }

        console.setStyle(paragraph, "-fx-fill: " + color + "; -fx-font-family: monospace;");
        console.requestFollowCaret();
    }

    private final ConcurrentLinkedQueue<Integer> charsQueue = new ConcurrentLinkedQueue<>(); //buffer na znaky
    private final Semaphore allowedToWrite = new Semaphore(1); //povolenie zapisu

    /**
     * "Škrtiaca klapka" proti zaplneniu RunLater queue na FXApplicationThread-e.
     * Výpis povolený na 15ms. Ak po tomto čase v buffery nieco ostalo, naplánuje sa opätovné spustenie.
     * Až do skončenia a povolenia semaforu zápisu zamyká konzolu.
     */
    private void fxWriteThrottle() {
        console.setDisable(true);
        long start = System.currentTimeMillis();

        synchronized (charsQueue) {
            while (System.currentTimeMillis() - start < 15 && charsQueue.peek() != null) {
                writeToConsole(charsQueue.poll());
            }

            if (charsQueue.peek() != null) {
                //ak mas este co vyflusnut na konzolu, naplanuj svoje dalsie ucinkovanie
                Platform.runLater(this::fxWriteThrottle);
            } else {
                //ak nemas, povol CPU naplanovat dalsi zapis
                console.setDisable(false);
                allowedToWrite.release();
            }
        }
    }

    public void clearBuffer() {
        charsQueue.clear();
    }

    @Override
    public void write(int b) throws IOException {
        synchronized (charsQueue) {
            charsQueue.add(b);
            if (!Platform.isFxApplicationThread() && allowedToWrite.tryAcquire()) {
                Platform.runLater(this::fxWriteThrottle);
            }
        }
    }

    @Override
    public void write(byte[] b) throws IOException {
        for (int i = 0; i < b.length; i++){
            write(b[i]);
        }
    }

    @Override
    public void write(byte[] b, int off, int len) throws IOException {
        if(off < 0 || len < 0 || off + len > b.length) throw new IOException("Invalid argument");

        for (int i = off; i < off + len; i++){
            write(b[i]);
        }
    }
}
