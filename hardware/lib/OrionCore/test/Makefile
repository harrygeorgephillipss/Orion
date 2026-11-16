CXX ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Werror -O1 -fsanitize=address,undefined
SRC = ../src/orion_safety.cpp ../src/orion_link.cpp ../src/orion_sim800.cpp ../src/orion_setup.cpp test_main.cpp
run: orion_tests
	./orion_tests
orion_tests: $(SRC) ../src/*.h
	$(CXX) $(CXXFLAGS) -o $@ $(SRC)
clean:
	rm -f orion_tests
.PHONY: run clean
