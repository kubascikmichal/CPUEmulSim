; Stop during a micro-stepped OUT leaves IW_ asserted
        MVI A, 0x5A
        OUT 0x10, A
        MVI B, 1
