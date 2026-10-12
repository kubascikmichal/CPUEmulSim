Potrebujem opravit tieto chyby:

V editore programu:
1. PUS F / POP F prejdú parserom, no za behu program potichu skončí a CPU prejde do stavu Nečinný.
2. Návestia sa vyhodnocujú, len ak je v programe aspoň jedno návestie. Bez návestí JMP 5 skočí na inštrukciu č. 5 a JMP x za behu zastaví program. Za JMP musí vždy nasledovať návestie, ktoré musí byť definované. JMP 5 nemôže skákať na inštrukciu.
3. Návestie INT0a (veľké INT, malé hex písmeno) zhodí parser. Stav ostane navždy Parsujem... a žiadna chyba sa nevypíše. INT0A je zasa potichu obyčajné návestie a int0f s int15 sa považujú za to isté prerušenie. Mohlo by sa zjednodušiť tak, že int00 až int15 (aj INT00..INT15) by boli vyhradené pre obsluhu prerušení. Všetky ostatné návestia by boli obyčajnými návestiami.
4. Viac ako 256 konštánt BYTE pretečie tabuľku Konštanty a obnova GUI spadne. Treba doplniť kontrolu pretečenia.
5. ConsoleOutputStream.write(byte[]) zahodí posledný bajt (vidno to pri varovaní o zbernici).
6. Polia registrov sa dajú editovať, ale zmeny sa do CPU nikdy nezapíšu (CY je len na čítanie, Z a IE sa ignorujú). Registre sa nemajú dať editovať.
7. Odstraňovanie komentárov nerešpektuje úvodzovky, takže MVI A, ';' je chyba syntaxe. Uvedená inštrukcia by mala fungovať (asi to doteraz nikto nepoužil).
8. Zvýrazňovanie syntaxe berie návestia [a-zA-Z0-9]+:, parser však \w+:. Návestia s _ fungujú, ale nie sú zvýraznené. Všetky návestia by mali byť zvýraznené.

V editore schemy:
1. Kontextové menu LED má vždy predvolenú farbu Červená, aj keď má LED inú farbu.
2. Farbu vodiča sa dá zmeniť len úpravou súboru, v aplikácii na to nie je ovládací prvok.


Vsetky zmeny predtym somnou skonzultuj, az potom ked potvrdim implementaciu tak budeme implementovat.