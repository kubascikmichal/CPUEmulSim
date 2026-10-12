; a ';' inside quotes does not start a comment
        MVI A, ';'   ; real comment
        MVI B, ';'
        BYTE ';'     ; constant
