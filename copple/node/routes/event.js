const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const AWS = require('aws-sdk');
const cookieParser = require('cookie-parser');
const path = require('path');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() }); // 파일을 메모리에 버퍼로 저장
const app = express();

AWS.config.update({
  region: 'ap-northeast-2',
})
const S3 = new AWS.S3()
// 쿠키 파서 및 다른 미들웨어 설정
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// AWS DynamoDB 설정
const dynamodb = new AWS.DynamoDB({ region: 'ap-northeast-2' });


// 디버깅: 토큰이 올바르게 수신되었는지 확인
function requireLogin(req, res, next) {
  const token = req.cookies.token;
  console.log("Token:", token);

  if (!token) {
    return res.status(401).json({ detail: "인증되지 않았습니다 - 로그인이 필요합니다." });
  }

  try {
    const decoded = jwt.verify(token, 'secret_key');
    req.user = decoded;
    next();
  } catch (error) {
    console.error("토큰 유효성 검사 오류:", error);
    return res.status(401).json({ detail: "인증되지 않았습니다 - 잘못된 토큰입니다." });
  }
}


// 4) 목표 생성
app.post("/goal/create", requireLogin, upload.single("image"), async (req, res) => {
  const user = req.user;
  const { title, startDatetime, endDatetime, offset, location, content } = req.body;

  try {
    const fileBuffer = req.file.buffer;
    const fileType = req.file.mimetype;
    const userId = user.user_id;
    const key = `travel_photos/${uuidv4()}.jpg`;

    const params = {
      Bucket: 'seo-3169',
      Key: key,
      Body: fileBuffer,
      ContentType: fileType,
    };

    await S3.upload(params).promise();

    const imageUrl = `https://${params.Bucket}.s3.ap-northeast-2.amazonaws.com/${params.Key}`;

    // 나머지 데이터와 함께 DynamoDB에 저장
    const event_id = uuidv4();
    const eventType = 'Goal';

    const eventParams = {
      TableName: 'Event',
      Item: {
        'EventId': { S: event_id },
        'UserId': { S: userId },
        'EventType': { S: eventType },
        'Title': { S: title },
        'StartDatetime': { S: startDatetime },
        'EndDatetime': { S: endDatetime },
        'Offset': { N: String(offset) },
        'Location': { S: location },
        'Content': { S: content },
        'PhotoURL': { S: imageUrl }
      },
    };

    await dynamodb.putItem(eventParams).promise();

    const goalData = {
      event_id,
      user_id: userId,
      eventType,
      title,
      startDatetime,
      endDatetime,
      offset,
      location,
      content,
      photoUrl: imageUrl
    };

    res.cookie('goalData', JSON.stringify(goalData));
    return res.status(200).json({
      event_id,
      message: "목표가 성공적으로 생성되었습니다."
    });
  } catch (error) {
    console.error('An error occurred while creating the goal with image: ', error);
    return res.status(500).json({ detail: "목표를 생성하는 중 오류가 발생했습니다." });
  }
});


// 5) 목표 전체 조회
app.get("/goal/read", requireLogin, async (req, res) => {
  const user = req.user;
  const eventType = 'Goal';

  const params = {
    TableName: 'Event',
    FilterExpression: 'UserId = :userId AND EventType = :eventType',
    ExpressionAttributeValues: {
      ':userId': { S: user.user_id },
      ':eventType': { S: eventType },
    }
  };

  try {
    const response = await dynamodb.scan(params).promise();

    const goals = response.Items.map(item => ({
      event_id: item.EventId.S,
      user_id: item.UserId.S,
      eventType: item.EventType.S,
      title: item.Title.S,
      startDatetime: item.StartDatetime.S,
      endDatetime: item.EndDatetime.S,
      offset: Number(item.Offset.N),
      location: item.Location.S,
      content: item.Content.S,
      photoUrl: item.PhotoURL ? item.PhotoURL.S : null
    }));

    return res.json(goals);
  } catch (error) {
    console.error('An error occurred : ', error);
    return res.status(500).json({ detail: "내부 서버 오류" });
  }
});


// 6) 한 개의 목표 조회
app.get("/goal/read/:event_id", requireLogin, async (req, res) => {
  const user = req.user;
  const event_id = req.params.event_id;

  const params = {
    TableName: 'Event',
    Key: {
      'EventId': { S: event_id }
    },
  };

  try {
    const response = await dynamodb.getItem(params).promise();
    if (response.Item) {
      const goalData = {
        event_id: response.Item.EventId.S,
        user_id: response.Item.UserId.S,
        eventType: response.Item.EventType.S,
        title: response.Item.Title.S,
        startDatetime: response.Item.StartDatetime.S,
        endDatetime: response.Item.EndDatetime.S,
        offset: Number(response.Item.Offset.N), // Corrected the offset conversion
        location: response.Item.Location.S,
        content: response.Item.Content.S,
        photoUrl: response.Item.PhotoURL ? response.Item.PhotoURL.S : null
      };
      return res.json(goalData);
    } else {
      return res.status(404).json({ detail: "목표를 찾을 수 없습니다." });
    }
  } catch (error) {
    console.error('An error occurred : ', error);
    return res.status(500).json({ detail: "목표를 조회할 수 없습니다." });
  }
});


// 7) 목표 수정
app.put("/goal/update/:event_id", requireLogin, async (req, res) => {
  const event_id = req.params.event_id;
  const { title, startDatetime, endDatetime, offset, location, content, photoUrl } = req.body;

  // 업데이트 할 필드 목록 초기화
  const updateFields = [];

  // 필드가 주어진 경우에만 해당 필드를 업데이트 목록에 추가
  if (title) {
    updateFields.push('#title = :title');
  }
  if (startDatetime) {
    updateFields.push('#startDatetime = :startDatetime');
  }
  if (endDatetime) {
    updateFields.push('#endDatetime = :endDatetime');
  }
  if (offset !== undefined) {
    updateFields.push('#offset = :offset');
  }
  if (location) {
    updateFields.push('#location = :location');
  }
  if (content) {
    updateFields.push('#content = :content');
  }
  if (photoUrl !== undefined) {
    updateFields.push('#photoUrl = :photoUrl');
  }

  // 업데이트할 필드가 없으면 에러 메시지 반환
  if (updateFields.length === 0) {
    return res.status(400).json({ detail: "수정할 필드를 지정하세요." });
  }

  // UpdateExpression 생성
  const updateExpression = 'SET ' + updateFields.join(', ');

  const params = {
    TableName: 'Event',
    Key: {
      'EventId': { S: event_id }
    },
    // 업데이트 할 필드 및 값 정의
    UpdateExpression: updateExpression,
    // 필드 이름(Key 값)
    ExpressionAttributeNames: {
      '#title': 'Title',
      '#startDatetime': 'StartDatetime',
      '#endDatetime': 'EndDatetime',
      '#offset': 'Offset',
      '#location': 'Location',
      '#content': 'Content',
      '#photoUrl': 'PhotoURL'
    },
    // Value 값
    ExpressionAttributeValues: {
      ':title': { S: title },
      ':startDatetime': { S: startDatetime },
      ':endDatetime': { S: endDatetime },
      ':offset': { N: String(offset) },
      ':location': { S: location },
      ':content': { S: content },
      ':photoUrl': { S: photoUrl },
    }
  };

  try {
    const response = await dynamodb.updateItem(params).promise();

    if (response) {
      return res.json({ message: "목표가 성공적으로 업데이트되었습니다." });
    } else {
      return res.status(404).json({ detail: "목표를 찾을 수 없음" });
    }
  } catch (error) {
    console.error('An error occurred : ', error);
    return res.status(500).json({ detail: "내부 서버 오류" });
  }
});

// 8) 목표 삭제
app.delete("/goal/delete/:event_id", requireLogin, async (req, res) => {
  const user = req.user;
  const event_id = req.params.event_id;

  const params = {
    TableName: 'Event',
    Key: {
      'EventId': { S: event_id }
    }
  };

  try {
    const response = await dynamodb.deleteItem(params).promise();

    if (response) {
      return res.json({ message: "목표가 성공적으로 삭제되었습니다." });
    } else {
      return res.status(404).json({ detail: "목표를 찾을 수 없음" });
    }
  } catch (error) {
    console.error('An error occurred : ', error);
    return res.status(500).json({ detail: "내부 서버 오류" });
  }
});

// 9) 일정 생성
app.post("/event/create", requireLogin, async (req, res) => {
  const user = req.user;
  const { title, startDatetime, endDatetime, offset, goal, location, content } = req.body; //사용자 입력한 값 여기로 저장됨

  const event_id = uuidv4();
  const eventType = 'Event';

  const params = { //사용자가 입력할 값
    TableName: 'Event',
    Item: {
      'EventId': { S: event_id },
      'UserId': { S: user.user_id }, // 사용자 아이디를 세션 또는 토큰에서 추출한 값으로 설정
      'EventType': { S: eventType },
      'Title': { S: title },
      'StartDatetime': { S: startDatetime },
      'EndDatetime': { S: endDatetime },
      'Offset': { N: String(offset) },
      'Goal': { S: goal },
      'Location': { S: location },
      'Content': { S: content }
    },
  };

  try {
    await dynamodb.putItem(params).promise();
    const eventData = {
      event_id,
      user_id: user.user_id,
      eventType,
      title,
      startDatetime,
      endDatetime,
      offset,
      goal,
      location,
      content
    };

    res.cookie("eventData", JSON.stringify(eventData));
    return res.status(200).json({
      event_id,
      message: '일정이 성공적으로 생성되었습니다.'
    });
  } catch (error) {
    console.error('An error occurred : ', error);
    return res.status(500).json({ detail: '내부 서버 오류' });
  }
});

// 10) 일정 전체 조회
app.get("/event/read", requireLogin, async (req, res) => {
  const user = req.user;
  const eventType = 'Event'

  const params = {
    TableName: 'Event',
    FilterExpression: 'UserId = :userId AND EventType = :eventType',
    ExpressionAttributeValues: { //
      ':userId': { S: user.user_id },
      ':eventType': { S: eventType },
    }
  };

  try {
    const response = await dynamodb.scan(params).promise();

    const events = response.Items.map(item => ({
      event_id: item.EventId.S,
      user_id: item.UserId.S,
      eventType: item.EventType.S,
      title: item.Title.S,
      startDatetime: item.StartDatetime.S,
      endDatetime: item.EndDatetime.S,
      offset: Number(item.Offset.N),
      goal: item.Goal.S,
      location: item.Location.S,
      content: item.Content.S
    }));

    return res.json(events);
  } catch (error) {
    console.error('An error occurred : ', error);
    return res.status(500).json({ detail: "내부 서버 오류" });
  }
});

// 11) 일정 하나만 조회
app.get("/event/read/:event_id", requireLogin, async (req, res) => {
  const user = req.user;
  const event_id = req.params.event_id;

  const params = {
    TableName: 'Event',
    Key: {
      'EventId': { S: event_id }
    }
  };
  try {
    const response = await dynamodb.getItem(params).promise();
    if (response.Item) {
      const eventData = {
        event_id: response.Item.EventId.S,
        user_id: response.Item.UserId.S,
        eventType: response.Item.EventType.S,
        title: response.Item.Title.S,
        startDatetime: response.Item.StartDatetime.S,
        endDatetime: response.Item.EndDatetime.S,
        goal: response.Item.Goal.S,
        offset: Number(response.Item.Offset.N),
        location: response.Item.Location.S,
        content: response.Item.Content.S
      };
      return res.json(eventData);
    } else {
      return res.status(404).json({ detail: "일정을 찾을 수 없습니다." });
    }
  } catch (error) {
    console.error('An error occurred : ', error);
    return res.status(500).json({ detail: '일정을 조회할 수 없습니다.' })
  }
})

// 12) 일정 수정
app.put("/event/update/:event_id", requireLogin, async (req, res) => {
  const event_id = req.params.event_id;
  const { title, startDatetime, endDatetime, offset, goal, location, content } = req.body;

  //업데이트할 필드 목록 초기화
  const updateFields = [];

  //필드가 주어진 경우에만 해당 필드를 업테이트 목록에 추가
  if (title) {
    updateFields.push('#title = :title');
  }
  if (startDatetime) {
    updateFields.push('#startDatetime = :startDatetime');
  }
  if (endDatetime) {
    updateFields.push('#endDatetime = :endDatetime');
  }
  if (offset !== undefined) {
    updateFields.push('#offset = :offset');
  }
  if (goal) {
    updateFields.push('#goal = :goal');
  }
  if (location) {
    updateFields.push('#location = :location');
  }
  if (content) {
    updateFields.push('#content = :content');
  }

  // 업데이트할 필드가 없으면 에러 메시지 반환
  if (updateFields.length === 0) {
    return res.status(400).json({ detail: "수정할 필드를 지정하세요." });
  }

  // UpdateExpression 생성
  const updateExpression = 'SET ' + updateFields.join(', ');

  const params = {
    TableName: 'Event',
    Key: {
      'EventId': { S: event_id }
    },
    // 업데이트 할 필드 및 값 정의
    UpdateExpression: updateExpression,
    // 필드 이름(Key 값)
    ExpressionAttributeNames: {
      '#title': 'Title',
      '#startDatetime': 'StartDatetime',
      '#endDatetime': 'EndDatetime',
      '#offset': 'Offset',
      '#goal': 'Goal',
      '#location': 'Location',
      '#content': 'Content'
    },
    ExpressionAttributeValues: {
      ':title': { S: title },
      ':startDatetime': { S: startDatetime },
      ':endDatetime': { S: endDatetime },
      ':offset': { N: String(offset) },
      ':goal': { S: goal },
      ':location': { S: location },
      ':content': { S: content }
    }
  };

  try {
    const response = await dynamodb.updateItem(params).promise();

    if (response) {
      return res.json({ message: "일정이 성공적으로 업데이트되었습니다." });
    } else {
      return res.status(404).json({ detail: "일정을 찾을 수 없음" });
    }
  } catch (error) {
    console.error('An error occurred :', error);
    return res.status(500).json({ detail: "내부 서버 오류" });
  }
});

// 13)일정 삭제
app.delete("/event/delete/:event_id", requireLogin, async (req, res) => {
  const user = req.user;
  const event_id = req.params.event_id;

  const params = {
    TableName: 'Event',
    Key: {
      'EventId': { S: event_id }
    }
  };

  try {
    const response = await dynamodb.deleteItem(params).promise();

    if (response) {
      return res.json({ message: "일정이 성공적으로 삭제되었습니다." });
    } else {
      return res.status(404).json({ detail: "일정을 찾을 수 없음" });
    }
  } catch (error) {
    console.error('An error occurred :', error);
    return res.status(500).json({ detail: "내부 서버 오류" });
  }
})

// 14) 할 일 생성
app.post("/todo/create", requireLogin, async (req, res) => {
  const user = req.user;
  const { title, goal, location, content } = req.body;

  const event_id = uuidv4();
  const eventType = 'Todo';

  const params = {
    TableName: 'Event',
    Item: {
      'EventId': { S: event_id },
      'UserId': { S: user.user_id },
      'EventType': { S: eventType },
      'Title': { S: title },
      'Goal': { S: goal },
      'Location': { S: location },
      'Content': { S: content }
    },
  };

  try {
    await dynamodb.putItem(params).promise();
    const todoData = {
      event_id,
      user_id: user.user_id,
      eventType,
      title,
      goal,
      location,
      content
    };

    res.cookie("todoData", JSON.stringify(todoData));
    return res.status(200).json({
      event_id,
      message: '할 일이 성공적으로 생성되었습니다.'
    });
  } catch (error) {
    console.error('An error occurred : ', error);
    return res.status(500).json({ detail: '내부 서버 오류' });
  }
});

//15) 할 일 전체 조회
app.get("/todo/read", requireLogin, async (req, res) => {
  const user = req.user;
  const eventType = 'Todo'

  const params = {
    TableName: 'Event',
    FilterExpression: 'UserId = :userId and EventType = :eventType',
    ExpressionAttributeValues: {
      ':userId': { S: user.user_id },
      ':eventType': { S: eventType },
    }
  };

  try {
    const response = await dynamodb.scan(params).promise();

    const todos = response.Items.map(item => ({
      event_id: item.EventId.S,
      user_id: item.UserId.S,
      eventType: item.EventType.S,
      title: item.Title.S,
      goal: item.Goal.S,
      location: item.Location.S,
      content: item.Content.S
    }));

    return res.json(todos)
  } catch (error) {
    console.error('An error occurred : ', error);
  }
})

// 16) 할 일 하나만 조회
app.get("/todo/read/:event_id", requireLogin, async (req, res) => {
  const user = req.user;
  const event_id = req.params.event_id;

  const params = {
    TableName: 'Event',
    Key: {
      'EventId': { S: event_id }
    }
  };
  try {
    const response = await dynamodb.getItem(params).promise();
    if (response.Item) {
      const todoData = {
        event_id: response.Item.EventId.S,
        user_id: response.Item.UserId.S,
        eventType: response.Item.EventType.S,
        title: response.Item.Title.S,
        goal: response.Item.Goal.S,
        location: response.Item.Location.S,
        content: response.Item.Content.S
      };
      return res.json(todoData);
    } else {
      return res.status(404).json({ detail: "할 일을 찾을 수 없습니다. " })
    }
  } catch (error) {
    console.error('An error occurred : ', error);
    return res.status(500).json({ detail: '할 일을 조회할 수 없습니다.' })
  }
})

// 17) 할 일 수정
app.put("/todo/update/:event_id", requireLogin, async (req, res) => {
  const event_id = req.params.event_id;
  const { title, goal, location, content } = req.body;

  //업데이트할 필드 목록 초기화
  const updateFields = [];

  //필드가 주어진 경우에만 해당 필드를 업테이트 목록에 추가
  if (title) {
    updateFields.push('#title = :title');
  }
  if (goal) {
    updateFields.push('#goal = :goal');
  }
  if (location) {
    updateFields.push('#location = :location');
  }
  if (content) {
    updateFields.push('#content = :content');
  }
  // 업데이트할 필드가 없으면 에러 메시지 반환
  if (updateFields.length === 0) {
    return res.status(400).json({ detail: "수정할 필드를 지정하세요." });
  }

  // UpdateExpression 생성
  const updateExpression = 'SET ' + updateFields.join(', ');

  const params = {
    TableName: 'Event',
    Key: {
      'EventId': { S: event_id }
    },
    // 업데이트 할 필드 및 값 정의
    UpdateExpression: updateExpression,
    // 필드 이름(key 값)
    ExpressionAttributeNames: {
      '#title': 'Title',
      '#goal': 'Goal',
      '#location': 'Location',
      '#content': 'Content'
    },
    ExpressionAttributeValues: {
      ':title': { S: title },
      ':goal': { S: goal },
      ':location': { S: location },
      ':content': { S: content }
    }
  };

  try {
    const response = await dynamodb.updateItem(params).promise();

    if (response) {
      return res.json({ message: "할 일이 성공적으로 업데이트되었습니다." });
    } else {
      return res.status(404).json({ detail: "할 일을 찾을 수 없음" });
    }
  } catch (error) {
    console.error('An error occurred :', error);
    return res.status(500).json({ detail: "내부 서버 오류" });
  }
});

//18) 할 일 삭제
app.delete("/todo/delete/:event_id", requireLogin, async (req, res) => {
  const user = req.user;
  const event_id = req.params.event_id;

  const params = {
    TableName: 'Event',
    Key: {
      'EventId': { S: event_id }
    }
  };

  try {
    const response = await dynamodb.deleteItem(params).promise();

    if (response) {
      return res.json({ message: "할 일이 성공적으로 삭제되었습니다." });
    } else {
      return res.status(404).json({ detail: "할 일을 찾을 수 없음" });
    }
  } catch (error) {
    console.error('An error occurred :', error);
    return res.status(500).json({ detail: "내부 서버 오류" });
  }
})

module.exports = app;