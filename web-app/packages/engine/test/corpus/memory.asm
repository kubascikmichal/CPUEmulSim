; internal RAM, program constants
        BYTE 10
        BYTE 0xFF
        BYTE 101b
        BYTE 017
        BYTE 'z'
        MVI A, 0
        MMR B, A
        INC A
        MMR C, A
        MVI A, 4
        MMR D, A
        MVI A, 200
        MMR D, A
        MVI A, 7
        MVI B, 99
        STR A, B
        LDR C, A
        MVI A, 255
        STR A, A
        LDR D, A
