; register F: bit0 = CY, bit1 = Z, bit2 = IE
        MVI A, 0xFF
        ADI A, 1
        EIT
        NOP_LIKE: MVI B, 0
        PUS F
        POP A
        DIT
        MVI B, 0
        ADI B, 1
        PUS F
        MVI C, 7
        PUS C
        POP F
        POP D
