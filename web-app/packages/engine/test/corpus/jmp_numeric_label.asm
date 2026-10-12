; a label may consist of digits; JMP 5 then jumps to label 5, not to instruction 5
        MVI A, 1
        JMP 5
        MVI A, 2
5:      MVI B, 3
        MVI C, 4
