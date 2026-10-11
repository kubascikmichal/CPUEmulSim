; keyboard system calls
        SCALL KPR
        SCALL KEY
        MOV A, D
        SCALL KEY
        MOV B, D
        SCALL KPR
        SCALL KEY
        MOV C, D
        SCALL KEY
        SCALL DSP
