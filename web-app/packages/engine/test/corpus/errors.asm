dup:    MVI A, 1
dup:    MVI A, 2
        FOO A, B
        MVI A
        MVI E, 1
        MVI A, 256
        ADD A, 5
        MVX C, A
        MVX S, M
        SHL A, 9
        JMP nowhere
int03:  NOP
int03:  MVI A, 3
int03b: MVI A, 4
        SCALL XYZ
