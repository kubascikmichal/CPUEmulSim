; EIT enables IE before the following instruction
        EIT
        NOP_LIKE: MVI A, 1
        DIT
        EIT
        EIT
        DIT
int00:  MVI A, 2
int15:  MVI B, 3
INT05:  MVI D, 5
handler: MVI D, 6
