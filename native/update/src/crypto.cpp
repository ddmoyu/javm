#include "crypto.hpp"
#include <array>
#include <fstream>
#include <stdexcept>
#ifdef _WIN32
// clang-format off
#include <windows.h>
#include <bcrypt.h>
// clang-format on
#else
#include <openssl/core_names.h>
#include <openssl/ec.h>
#include <openssl/evp.h>
#include <openssl/param_build.h>
#endif
namespace javm::update {
std::vector<unsigned char> unhex(const std::string &value) {
  if (value.size() % 2)
    throw std::runtime_error("签名编码无效");
  auto digit = [](char c) -> unsigned {
    if (c >= '0' && c <= '9')
      return c - '0';
    if (c >= 'a' && c <= 'f')
      return c - 'a' + 10;
    throw std::runtime_error("签名编码无效");
  };
  std::vector<unsigned char> out(value.size() / 2);
  for (size_t i = 0; i < out.size(); ++i)
    out[i] = static_cast<unsigned char>((digit(value[2 * i]) << 4) |
                                        digit(value[2 * i + 1]));
  return out;
}
std::string hex(const unsigned char *data, size_t size) {
  static const char digits[] = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (size_t i = 0; i < size; ++i) {
    out += digits[data[i] >> 4];
    out += digits[data[i] & 15];
  }
  return out;
}
class Hash {
#ifdef _WIN32
  BCRYPT_ALG_HANDLE algorithm{};
  BCRYPT_HASH_HANDLE handle{};
#else
  EVP_MD_CTX *handle{};
#endif
public:
  Hash() {
#ifdef _WIN32
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM,
                                    nullptr, 0) < 0 ||
        BCryptCreateHash(algorithm, &handle, nullptr, 0, nullptr, 0, 0) < 0)
      throw std::runtime_error("无法初始化更新校验");
#else
    handle = EVP_MD_CTX_new();
    if (!handle || EVP_DigestInit_ex(handle, EVP_sha256(), nullptr) != 1)
      throw std::runtime_error("无法初始化更新校验");
#endif
  }
  ~Hash() {
#ifdef _WIN32
    if (handle)
      BCryptDestroyHash(handle);
    if (algorithm)
      BCryptCloseAlgorithmProvider(algorithm, 0);
#else
    EVP_MD_CTX_free(handle);
#endif
  }
  void add(const void *data, size_t size) {
#ifdef _WIN32
    if (BCryptHashData(handle, static_cast<PUCHAR>(const_cast<void *>(data)),
                       static_cast<ULONG>(size), 0) < 0)
      throw std::runtime_error("更新校验失败");
#else
    if (EVP_DigestUpdate(handle, data, size) != 1)
      throw std::runtime_error("更新校验失败");
#endif
  }
  std::array<unsigned char, 32> finish() {
    std::array<unsigned char, 32> bytes{};
#ifdef _WIN32
    if (BCryptFinishHash(handle, bytes.data(), 32, 0) < 0)
      throw std::runtime_error("更新校验失败");
#else
    unsigned int count = 0;
    if (EVP_DigestFinal_ex(handle, bytes.data(), &count) != 1 || count != 32)
      throw std::runtime_error("更新校验失败");
#endif
    return bytes;
  }
};
std::string hashFile(const std::filesystem::path &path,
                     const std::atomic<bool> *cancel) {
  std::ifstream input(path, std::ios::binary);
  if (!input)
    throw std::runtime_error("无法读取更新文件");
  Hash hash;
  std::array<char, 65536> buffer{};
  while (input) {
    if (cancel && *cancel)
      throw std::runtime_error("更新校验已取消");
    input.read(buffer.data(), buffer.size());
    hash.add(buffer.data(), static_cast<size_t>(input.gcount()));
  }
  if (!input.eof())
    throw std::runtime_error("更新文件读取失败");
  const auto bytes = hash.finish();
  return hex(bytes.data(), bytes.size());
}
bool verifySignature(const std::string &payload, const std::string &signature,
                     const std::string &publicKey) {
  if (publicKey.size() != 130 || signature.size() != 128 ||
      payload.size() > 1024 * 1024)
    return false;
  const auto key = unhex(publicKey), sig = unhex(signature);
  if (key[0] != 4)
    return false;
#ifdef _WIN32
  BCRYPT_ALG_HANDLE algorithm{};
  BCRYPT_KEY_HANDLE handle{};
  bool valid = false;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_ECDSA_P256_ALGORITHM,
                                  nullptr, 0) < 0)
    return false;
  std::array<unsigned char, sizeof(BCRYPT_ECCKEY_BLOB) + 64> blob{};
  BCRYPT_ECCKEY_BLOB header{BCRYPT_ECDSA_PUBLIC_P256_MAGIC, 32};
  memcpy(blob.data(), &header, sizeof(header));
  memcpy(blob.data() + sizeof(header), key.data() + 1, 64);
  if (BCryptImportKeyPair(algorithm, nullptr, BCRYPT_ECCPUBLIC_BLOB, &handle,
                          blob.data(), static_cast<ULONG>(blob.size()),
                          0) >= 0) {
    Hash hash;
    hash.add(payload.data(), payload.size());
    auto digest = hash.finish();
    valid = BCryptVerifySignature(handle, nullptr, digest.data(), 32,
                                  const_cast<PUCHAR>(sig.data()), 64, 0) >= 0;
    BCryptDestroyKey(handle);
  }
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return valid;
#else
  EVP_PKEY_CTX *context = EVP_PKEY_CTX_new_from_name(nullptr, "EC", nullptr);
  EVP_PKEY *handle = nullptr;
  char group[] = "prime256v1";
  OSSL_PARAM params[] = {
      OSSL_PARAM_construct_utf8_string(OSSL_PKEY_PARAM_GROUP_NAME, group, 0),
      OSSL_PARAM_construct_octet_string(OSSL_PKEY_PARAM_PUB_KEY,
                                        const_cast<unsigned char *>(key.data()),
                                        key.size()),
      OSSL_PARAM_construct_end()};
  if (!context)
    return false;
  bool valid =
      EVP_PKEY_fromdata_init(context) == 1 &&
      EVP_PKEY_fromdata(context, &handle, EVP_PKEY_PUBLIC_KEY, params) == 1;
  EVP_PKEY_CTX_free(context);
  if (!valid) {
    EVP_PKEY_free(handle);
    return false;
  }
  ECDSA_SIG *pair = ECDSA_SIG_new();
  ECDSA_SIG_set0(pair, BN_bin2bn(sig.data(), 32, nullptr),
                 BN_bin2bn(sig.data() + 32, 32, nullptr));
  unsigned char *der = nullptr;
  const int length = i2d_ECDSA_SIG(pair, &der);
  ECDSA_SIG_free(pair);
  EVP_MD_CTX *digest = EVP_MD_CTX_new();
  valid =
      length > 0 && digest &&
      EVP_DigestVerifyInit(digest, nullptr, EVP_sha256(), nullptr, handle) ==
          1 &&
      EVP_DigestVerify(digest, der, static_cast<size_t>(length),
                       reinterpret_cast<const unsigned char *>(payload.data()),
                       payload.size()) == 1;
  EVP_MD_CTX_free(digest);
  EVP_PKEY_free(handle);
  OPENSSL_free(der);
  return valid;
#endif
}
} // namespace javm::update
