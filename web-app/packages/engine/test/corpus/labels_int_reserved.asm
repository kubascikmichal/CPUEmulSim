; only int00..int15 / INT00..INT15 are allowed; any other label starting with "int" is an error
int00:  MVI A, 1
INT15:  MVI A, 2
INT0a:  MVI A, 3
INT0A:  MVI A, 4
int0f:  MVI A, 5
Int05:  MVI A, 6
int16:  MVI A, 7
interrupt: MVI A, 8
integer: MVI A, 9
loop:   JMP loop
