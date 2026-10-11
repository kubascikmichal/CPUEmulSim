; stack push/pop 8 and 16 bit, SP wrap from 0
        MVI A, 0x12
        MVI B, 0x34
        PUS A
        PUS B
        MXI M, 0xBEEF
        PUS M
        MXI M, 0
        POP M
        POP C
        POP D
        INX S
        DCX S
        DCX S
        INX M
        DCX M
        MXI S, 0xFFFF
        PUS A
        POP B
        MXI S, 0
        POP A
        MVX C, S
        MVX M, A
        MVX S, A
        MVX C, M
