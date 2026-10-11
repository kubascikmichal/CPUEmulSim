; conditional jumps and loop
start:  MVI A, 5
        MVI B, 0
loop:   ADD B, A
        DEC A
        JNZ loop
        CMI B, 15
        JE eq
        MVI C, 1
eq:     CMI B, 16
        JL less
        MVI C, 2
less:   CMI B, 14
        JG greater
        MVI C, 3
greater: JLE never
        JGE ge
never:  MVI D, 99
ge:     JNG never2
        JNL nl
never2: MVI D, 98
nl:     CMP A, A
        JZR z1
        MVI D, 97
z1:     JNC nc
        MVI D, 96
nc:     JCY never3
        JMP end
never3: MVI D, 95
end:    MVI D, 1
