// sigv4-vectors.js — a verbatim subset of the official AWS `aws-sig-v4-test-suite`
// (the suite AWS publishes alongside the Signature Version 4 documentation;
// this copy was taken from boto/botocore@develop
// tests/unit/auth/aws4_testsuite, Apache-2.0).
//
// Fixed credentials for every case, per the suite's own documentation:
//   AWS_ACCESS_KEY_ID     = AKIDEXAMPLE
//   AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
//   region = us-east-1   service = service   timestamp = 20150830T123600Z
//
// Each case carries the raw request (.req) plus AWS's expected canonical
// request (.creq), string-to-sign (.sts) and Authorization header (.authz), so
// `aws-ext sigv4 verify` can prove the signer byte-for-byte with no network and
// no credentials. Cases cover: the vanilla GET/POST baseline, query-string
// sorting, header-value trimming, repeated header names, the
// x-www-form-urlencoded body shape `aws sts get-caller-identity` sends, and a
// signed x-amz-security-token (STS session credentials).

module.exports = {
  ACCESS_KEY_ID: 'AKIDEXAMPLE',
  SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  REGION: 'us-east-1',
  SERVICE: 'service',
  VECTORS: [
    {
      "name": "get-vanilla",
      "req": "GET / HTTP/1.1\nHost:example.amazonaws.com\nX-Amz-Date:20150830T123600Z",
      "creq": "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "sts": "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
      "authz": "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
    },
    {
      "name": "get-vanilla-query-order-key-case",
      "req": "GET /?Param2=value2&Param1=value1 HTTP/1.1\nHost:example.amazonaws.com\nX-Amz-Date:20150830T123600Z",
      "creq": "GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "sts": "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0",
      "authz": "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"
    },
    {
      "name": "get-header-value-trim",
      "req": "GET / HTTP/1.1\nHost:example.amazonaws.com\nMy-Header1: value1\nMy-Header2: \"a   b   c\"\nX-Amz-Date:20150830T123600Z",
      "creq": "GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nmy-header2:\"a b c\"\nx-amz-date:20150830T123600Z\n\nhost;my-header1;my-header2;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "sts": "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\na726db9b0df21c14f559d0a978e563112acb1b9e05476f0a6a1c7d68f28605c7",
      "authz": "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;my-header1;my-header2;x-amz-date, Signature=acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736"
    },
    {
      "name": "get-header-key-duplicate",
      "req": "GET / HTTP/1.1\nHost:example.amazonaws.com\nMy-Header1:value2\nMy-Header1:value2\nMy-Header1:value1\nX-Amz-Date:20150830T123600Z",
      "creq": "GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value2,value2,value1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "sts": "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\ndc7f04a3abfde8d472b0ab1a418b741b7c67174dad1551b4117b15527fbe966c",
      "authz": "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;my-header1;x-amz-date, Signature=c9d5ea9f3f72853aea855b47ea873832890dbdd183b4468f858259531a5138ea"
    },
    {
      "name": "post-vanilla",
      "req": "POST / HTTP/1.1\nHost:example.amazonaws.com\nX-Amz-Date:20150830T123600Z",
      "creq": "POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "sts": "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87",
      "authz": "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"
    },
    {
      "name": "post-x-www-form-urlencoded",
      "req": "POST / HTTP/1.1\nContent-Type:application/x-www-form-urlencoded\nHost:example.amazonaws.com\nX-Amz-Date:20150830T123600Z\n\nParam1=value1",
      "creq": "POST\n/\n\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\ncontent-type;host;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
      "sts": "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n42a5e5bb34198acb3e84da4f085bb7927f2bc277ca766e6d19c73c2154021281",
      "authz": "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a"
    },
    {
      "name": "post-x-www-form-urlencoded-parameters",
      "req": "POST / HTTP/1.1\nContent-Type:application/x-www-form-urlencoded; charset=utf8\nHost:example.amazonaws.com\nX-Amz-Date:20150830T123600Z\n\nParam1=value1",
      "creq": "POST\n/\n\ncontent-type:application/x-www-form-urlencoded; charset=utf8\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\ncontent-type;host;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
      "sts": "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n2e1cf7ed91881a30569e46552437e4156c823447bf1781b921b5d486c568dd1c",
      "authz": "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=1a72ec8f64bd914b0e42e42607c7fbce7fb2c7465f63e3092b3b0d39fa77a6fe"
    },
    {
      "name": "post-sts-header-before",
      "req": "POST / HTTP/1.1\nHost:example.amazonaws.com\nX-Amz-Date:20150830T123600Z\nX-Amz-Security-Token:AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==",
      "creq": "POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\nx-amz-security-token:AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==\n\nhost;x-amz-date;x-amz-security-token\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "sts": "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nc237e1b440d4c63c32ca95b5b99481081cb7b13c7e40434868e71567c1a882f6",
      "authz": "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead"
    }
  ],
};
