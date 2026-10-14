#include "engine.hpp"
#include <iostream>
template <class Char> int run(int argc, Char *argv[]) {
  try {
    const auto command =
        argc > 1 ? javm::update::utf8(std::filesystem::path(argv[1])) : "";
    if (argc != 3 ||
        (command != "--apply" && command != "--recover" &&
         command != "--program" && command != "--rollback-program"))
      throw std::runtime_error(
          "用法：javm_updater --apply|--recover <transaction>");
    if (command == "--program" || command == "--rollback-program")
      javm::update::privilegedProgramStep(std::filesystem::path(argv[2]),
                                          command == "--rollback-program");
    else
      javm::update::applyUpdate(std::filesystem::path(argv[2]),
                                command == "--recover");
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
#ifdef _WIN32
int wmain(int argc, wchar_t *argv[]) { return run(argc, argv); }
#else
int main(int argc, char *argv[]) { return run(argc, argv); }
#endif
