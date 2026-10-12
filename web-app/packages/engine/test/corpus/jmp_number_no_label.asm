; a jump operand must be a defined label, even when the program has no labels
        MVI A, 1
        JMP 3
        MVI A, 2
        MVI B, 3
