; bus cycles with simulation off (seeded random bus values, console warning)
        MVI A, 0x55
        OUT 0xFF, A
        INN B, 0xFF
        MXI M, 0x2000
        SMR A
        LMR C
        SMI 0x1FFF, A
        LMI D, 0x1FFF
