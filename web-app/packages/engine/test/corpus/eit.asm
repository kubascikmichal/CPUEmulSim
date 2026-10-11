; EIT enables IE before the following instruction
        EIT
        NOP_LIKE: MVI A, 1
        DIT
        EIT
        EIT
        DIT
int00:  MVI A, 2
int0f:  MVI B, 3
INT05:  MVI D, 5
interrupt: MVI D, 6
