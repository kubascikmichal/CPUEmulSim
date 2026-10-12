; an undefined label is a parse error, even when the program has no labels
        MVI A, 1
        JMP foo
        CAL bar
        MVI A, 2
