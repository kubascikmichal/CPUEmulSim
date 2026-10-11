; breakpoints + continue (breaks on lines 3 and 5, line 6 is a comment-only line)
        MVI A, 3
loop:   DEC A
        MVI B, 1
        MVI C, 2
        JNZ loop
; end
        MVI D, 9
