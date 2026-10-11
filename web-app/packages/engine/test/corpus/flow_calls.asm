; calls, conditional calls, returns
        MXI S, 0x0100
        CAL sub1
        CMI A, 1
        CE sub2
        CNE sub3
        CL sub3
        CNL sub2
        CG sub2
        CNG sub3
        CLE sub3
        CGE sub2
        CZR sub2
        CNZ sub3
        CCY sub3
        CNC sub2
        JMP end
sub1:   MVI A, 1
        RET
sub2:   INC B
        RET
sub3:   INC C
        RET
end:    MOV D, B
